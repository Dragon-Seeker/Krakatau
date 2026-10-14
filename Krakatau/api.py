"""Programmatic API for the decompiler, used by the browser worker (Pyodide) and usable from CPython.

    from Krakatau.api import Session
    with Session(['/work/mod.jar', '/stubs/jdk-stubs.jar']) as s:
        names = s.list_classes('/work/mod.jar')
        result = s.decompile('com/example/Foo')   # {'source': ..., 'error': None}

        # with the output line each bytecode offset was printed on, per method:
        result = s.decompile('com/example/Foo', mapped=True)
        # {'source': ..., 'error': None, 'methods': [{'owner': 'com/example/Foo', 'name': 'run',
        #   'descriptor': '()V', 'lines': [[0, 12], [7, 13]], 'original': None}, ...]}
"""
import contextlib
import io
import struct
import traceback
import zipfile

import Krakatau.ssa
from Krakatau.environment import Environment
from Krakatau.error import ClassLoaderError
from Krakatau.java import javaclass, visitor
from Krakatau.java.stringescape import escapeString
from Krakatau.verifier.inference_verifier import verifyBytecode

def _makeGraph(magic_throw, m):
    v = verifyBytecode(m.code)
    s = Krakatau.ssa.ssaFromVerified(m.code, v, magic_throw)
    if s.procs:
        s.inlineSubprocs()
    s.condenseBlocks()
    s.mergeSingleSuccessorBlocks()
    s.removeUnusedVariables()
    s.copyPropagation()
    s.abstractInterpert()
    s.disconnectConstantVariables()
    s.simplifyThrows()
    s.simplifyCatchIgnored()
    s.mergeSingleSuccessorBlocks()
    s.mergeSingleSuccessorBlocks()
    s.removeUnusedVariables()
    return s

_CP_SIZES = {3: 4, 4: 4, 5: 8, 6: 8, 7: 2, 8: 2, 9: 4, 10: 4, 11: 4, 12: 4, 15: 3, 16: 2, 17: 4, 18: 4, 19: 2, 20: 2}

def class_name_of(data):
    '''Internal name ("com/example/Foo") of a classfile, read from its this_class entry.'''
    return class_header(data)[0]

def class_header(data):
    '''(name, supername or None, [interface names]) read from a classfile's header.'''
    data = bytes(data)
    if data[:4] != b'\xca\xfe\xba\xbe':
        raise ValueError('Not a Java class file (bad magic)')
    count = struct.unpack_from('>H', data, 8)[0]
    pos, utf8, classes, i = 10, {}, {}, 1
    while i < count:
        tag = data[pos]
        if tag == 1:
            n = struct.unpack_from('>H', data, pos + 1)[0]
            utf8[i] = data[pos + 3:pos + 3 + n]
            pos += 3 + n
        else:
            if tag == 7:
                classes[i] = struct.unpack_from('>H', data, pos + 1)[0]
            pos += 1 + _CP_SIZES[tag]
            if tag in (5, 6):
                i += 1
        i += 1
    this, sup, icount = struct.unpack_from('>HHH', data, pos + 2)
    ifaces = struct.unpack_from('>' + 'H' * icount, data, pos + 8)
    name = lambda i: utf8[classes[i]].decode('utf8')
    return name(this), (name(sup) if sup else None), [name(i) for i in ifaces]

class Session(object):
    '''Keeps an Environment (and its open jar files) alive across calls, so library classes
    are only parsed once. Paths are searched in order: put the target jar first, stubs after.'''
    def __init__(self, paths, skip_errors=True, quiet=True):
        self.env = Environment()
        for p in paths:
            self.env.addToPath(p)
        self.env.__enter__()
        self.skip_errors = skip_errors
        self.quiet = quiet
        self.printer = visitor.DefaultVisitor()

    def close(self):
        self.env.__exit__(None, None, None)

    def __enter__(self): return self
    def __exit__(self, *args): self.close()

    @staticmethod
    def list_classes(jar_path):
        with zipfile.ZipFile(jar_path) as z:
            return sorted(n[:-len('.class')] for n in z.namelist()
                          if n.endswith('.class') and not n.endswith('module-info.class'))

    def add_classes(self, datas):
        '''Add classfiles from memory (e.g. siblings of a class you want to decompile). They stay
        available for later calls, override same-named classes from jars, and let the decompiler
        see supertypes and interfaces. Returns their internal names.'''
        names = []
        for data in datas:
            data = bytes(data)
            name = class_name_of(data)
            self.env.addClassBytes(name, data)
            names.append(name)
        return names

    def remove_classes(self, names):
        for name in names:
            self.env.removeClassBytes(name)

    def decompile_bytes(self, data, classpath=(), mapped=False):
        '''Decompile one classfile given as bytes. `classpath` classfiles are only visible for this
        call (classes added with add_classes stay). Returns {class_name, source, error, log}, plus
        `methods` with mapped=True (see decompile).'''
        data = bytes(data)
        try:
            name = class_name_of(data)
        except Exception as e:
            return {'class_name': None, 'source': None, 'error': 'Invalid class file: {}'.format(e), 'log': ''}
        temp = []
        previous = {}
        try:
            for extra in classpath:
                extra = bytes(extra)
                n = class_name_of(extra)
                if n not in previous:
                    previous[n] = self.env.memory.get(n)
                self.env.addClassBytes(n, extra)
                temp.append(n)
            previous.setdefault(name, self.env.memory.get(name))
            self.env.addClassBytes(name, data)
            result = self.decompile(name, mapped)
        finally:
            for n, old in previous.items(): # restore whatever was there before this call
                if old is None:
                    self.env.removeClassBytes(n)
                else:
                    self.env.addClassBytes(n, old)
        result['class_name'] = name
        return result

    def decompile(self, name, mapped=False):
        '''Decompile one class by internal name (e.g. "com/example/Foo"). Returns {source, error, log}.

        With mapped=True the result also has `methods`: for each method with printed code,
        {owner, name, descriptor, lines, original}, where `lines` are [bytecode offset, 1-based line in
        source] pairs sorted by offset (the line an instruction's code starts on; offsets of loads,
        stores and other instructions that don't become code of their own are absent), and `original`
        is always None. The source is the same either way.'''
        log = io.StringIO()
        source, error, methods = None, None, None
        with contextlib.redirect_stdout(log if self.quiet else _Tee(log)):
            try:
                # always parse the target fresh; it may have been loaded earlier as someone's supertype
                self.env.classes.pop(name, None)
                cls = self.env.getClass(name)
                ast = javaclass.generateAST(cls, lambda m: _makeGraph(False, m), self.skip_errors)
                if mapped:
                    printer = visitor.MappingVisitor()
                    source, positions = printer.finish(printer.visit(ast))
                else:
                    source, positions = self.printer.visit(ast), ()
                if '/' in name:
                    package = 'package {};\n\n'.format(escapeString(name.replace('/', '.').rpartition('.')[0]))
                    source = package + source
                    positions = [(o, n, d, off, line + package.count('\n')) for o, n, d, off, line in positions]
                if mapped:
                    methods = _methods(positions)
            except ClassLoaderError as e:
                error = 'Missing or invalid class: {}'.format(e.data)
            except Exception:
                error = traceback.format_exc()
            finally:
                # drop the fully-loaded target so memory doesn't grow with every class viewed
                self.env.classes.pop(name, None)
        result = {'source': source, 'error': error, 'log': log.getvalue()}
        if mapped:
            result['methods'] = methods or []
        return result

def _methods(positions):
    '''MappingVisitor positions -> [{owner, name, descriptor, lines, original}], keeping each offset's
    first (earliest printed) line'''
    by_method = {}
    for owner, name, desc, off, line in positions:
        by_method.setdefault((owner, name, desc), {}).setdefault(off, line)
    return [{'owner': o, 'name': n, 'descriptor': d, 'lines': [[off, lines[off]] for off in sorted(lines)], 'original': None}
            for (o, n, d), lines in by_method.items()]

class _Tee(io.StringIO):
    def __init__(self, other):
        super(_Tee, self).__init__()
        self.other = other
    def write(self, s):
        import sys
        sys.__stdout__.write(s)
        return self.other.write(s)

def decompile_jar(jar_path, lib_paths=(), names=None):
    '''Convenience: decompile every class (or the given names) in a jar. Returns {name: result}.'''
    with Session([jar_path] + list(lib_paths)) as s:
        targets = names if names is not None else s.list_classes(jar_path)
        return {n: s.decompile(n) for n in targets}
