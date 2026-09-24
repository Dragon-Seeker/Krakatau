"""Programmatic API for the decompiler, used by the browser worker (Pyodide) and usable from CPython.

    from Krakatau.api import Session
    with Session(['/work/mod.jar', '/stubs/jdk-stubs.jar']) as s:
        names = s.list_classes('/work/mod.jar')
        result = s.decompile('com/example/Foo')   # {'source': ..., 'error': None}
"""
import contextlib
import io
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

    def decompile(self, name):
        '''Decompile one class by internal name (e.g. "com/example/Foo"). Returns {source, error, log}.'''
        log = io.StringIO()
        source, error = None, None
        with contextlib.redirect_stdout(log if self.quiet else _Tee(log)):
            try:
                # always parse the target fresh; it may have been loaded earlier as someone's supertype
                self.env.classes.pop(name, None)
                cls = self.env.getClass(name)
                ast = javaclass.generateAST(cls, lambda m: _makeGraph(False, m), self.skip_errors)
                source = self.printer.visit(ast)
                if '/' in name:
                    source = 'package {};\n\n'.format(escapeString(name.replace('/', '.').rpartition('.')[0])) + source
            except ClassLoaderError as e:
                error = 'Missing or invalid class: {}'.format(e.data)
            except Exception:
                error = traceback.format_exc()
            finally:
                # drop the fully-loaded target so memory doesn't grow with every class viewed
                self.env.classes.pop(name, None)
        return {'source': source, 'error': error, 'log': log.getvalue()}

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
