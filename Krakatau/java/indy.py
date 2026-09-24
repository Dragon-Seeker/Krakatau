"""Resolution of invokedynamic call sites into readable Java.

Handles:
  * StringConcatFactory (Java 9+ string concatenation)      -> "a" + b + "c"
  * LambdaMetafactory (lambdas and method references)       -> x -> ..., Foo::bar
  * ObjectMethods (record toString/hashCode/equals)         -> removed from records
  * SwitchBootstraps (pattern / enum switches)              -> readable pseudo-call
  * anything else                                           -> pseudo-call naming the bootstrap

Lambda bodies are inlined by a class-level pass (postprocessClass) after every method
has been decompiled, since the body lives in a separate synthetic lambda$ method.
"""
import struct

from ..ssa import objtypes
from ..verifier.descriptors import parseFieldDescriptor, parseMethodDescriptor

from . import ast

REF_invokeVirtual, REF_invokeStatic, REF_invokeSpecial, REF_newInvokeSpecial, REF_invokeInterface = 5, 6, 7, 8, 9
_INSTANCE_KINDS = (REF_invokeVirtual, REF_invokeSpecial, REF_invokeInterface)

###############################################################################
# Constant pool / BootstrapMethods helpers

def _resolveConst(cpool, index):
    t = cpool.getType(index)
    args = cpool.getArgs(index)
    if t == 'MethodHandle':
        return ('MethodHandle',) + tuple(args) # kind, owner, name, desc
    if t == 'Dynamic':
        return ('Dynamic', args[1], args[2]) # name, desc
    return (t, args[0])

def _bootstrapTable(cls):
    table = getattr(cls, '_krak_bsms', None)
    if table is not None:
        return table
    table = []
    for name, data in (cls.attributes or []):
        if name != 'BootstrapMethods':
            continue
        count = struct.unpack_from('>H', data, 0)[0]
        pos = 2
        for _ in range(count):
            ref, nargs = struct.unpack_from('>HH', data, pos)
            pos += 4
            argrefs = struct.unpack_from('>' + 'H' * nargs, data, pos)
            pos += 2 * nargs
            table.append((ref, argrefs))
    cls._krak_bsms = table
    return table

def _typeFromName(name):
    '''Class constant name (possibly an array descriptor) -> TT'''
    if name.startswith('['):
        return objtypes.verifierToSynthetic(parseFieldDescriptor(name, unsynthesize=False)[0])
    return objtypes.TypeTT(name, 0)

def _constLiteral(c):
    kind = c[0]
    if kind == 'String':
        return ast.Literal(objtypes.StringTT, c[1])
    if kind == 'Int':
        return ast.Literal(objtypes.IntTT, c[1])
    if kind == 'Long':
        return ast.Literal(objtypes.LongTT, c[1])
    if kind == 'Float':
        return ast.Literal(objtypes.FloatTT, c[1])
    if kind == 'Double':
        return ast.Literal(objtypes.DoubleTT, c[1])
    if kind == 'Class':
        return ast.Literal(objtypes.ClassTT, _typeFromName(c[1]))
    return ast.Dummy('/*{}*/null'.format(' '.join(str(x) for x in c).replace('*/', '')), [], dtype=objtypes.ObjectTT)

###############################################################################
# New AST nodes

class PseudoCall(ast.JavaExpression):
    '''A readable stand-in for a call we can't express directly in Java.'''
    def __init__(self, comment, name, params, dtype, kind=None):
        self.comment, self.name = comment, name
        self.params = list(params)
        self.dtype = dtype
        self.kind = kind

    def print_(self, printer, print_):
        return '/*{}*/{}({})'.format(self.comment, self.name, ', '.join(print_(p) for p in self.params))

class MethodRefExpr(ast.JavaExpression):
    '''Foo::bar, expr::bar, Foo::new, super::bar'''
    def __init__(self, dtype, captured, handle, clsname):
        self.dtype = dtype
        self.params = list(captured) # empty, or the bound receiver
        self.handle = handle
        self.clsname = clsname

    def print_(self, printer, print_):
        kind, owner, name, desc = self.handle
        ownerName = print_(ast.TypeName(_typeFromName(owner)))
        if kind == REF_newInvokeSpecial:
            return ownerName + '::new'
        if self.params:
            recv = self.params[0]
            left = print_(recv)
            if kind == REF_invokeSpecial and owner != self.clsname and left == 'this':
                left = 'super'
        else:
            left = ownerName
        return '{}::{}'.format(left, name)

    def addParens_sub(self):
        if self.params and self.params[0].precedence > 0:
            self.params[0] = ast.Parenthesis(self.params[0])

class LambdaExpr(ast.JavaExpression):
    '''A lambda whose body is a synthetic lambda$ method. The body is attached by postprocessClass.'''
    precedence = 22 # lower than anything, so casts etc. will parenthesize us
    noInline = True # keep captured values as plain variables so they can be substituted into the body

    def __init__(self, dtype, captured, handle, clsname):
        self.dtype = dtype
        self.params = list(captured)
        self.handle = handle
        self.clsname = clsname
        self.inlineDef = None
        self.lambdaParams = []
        self.unsafeCaptures = [] # (lambda param local, captured expr) pairs we could not substitute

    def isInstance(self):
        return self.handle[0] in _INSTANCE_KINDS

    def captures(self):
        return self.params[1:] if self.isInstance() else self.params

    def print_(self, printer, print_):
        md = self.inlineDef
        if md is None:
            return self._printFallback(printer, print_)

        names = [print_(decl.local) for decl in self.lambdaParams]
        head = names[0] if len(names) == 1 else '(' + ', '.join(names) + ')'
        prefix = ''
        if self.unsafeCaptures:
            parts = ['{} = {}'.format(print_(local), print_(expr)) for local, expr in self.unsafeCaptures]
            prefix = '/*captures: {}*/ '.format(', '.join(parts))

        body = md.body
        stmts = body.statements
        if body.label is None and len(stmts) == 1:
            stmt = stmts[0]
            if isinstance(stmt, ast.ReturnStatement) and stmt.expr is not None:
                return '{}{} -> {}'.format(prefix, head, print_(stmt.expr))
            if isinstance(stmt, ast.ExpressionStatement) and isinstance(stmt.expr, (ast.MethodInvocation, ast.Assignment, ast.ClassInstanceCreation)):
                return '{}{} -> {}'.format(prefix, head, print_(stmt.expr))
        if not stmts and body.label is None:
            return '{}{} -> {{}}'.format(prefix, head)
        text = print_(body)
        if body.label is not None: # a labeled block isn't a valid lambda body on its own
            text = '{\n' + '\n'.join('    ' + l for l in text.splitlines()) + '\n}'
        return '{}{} -> {}'.format(prefix, head, text)

    def _printFallback(self, printer, print_):
        kind, owner, name, desc = self.handle
        caps = self.captures()
        if not caps:
            left = print_(self.params[0]) if self.isInstance() else print_(ast.TypeName(_typeFromName(owner)))
            return '{}::{}'.format(left, name)
        target = print_(self.params[0]) if self.isInstance() else print_(ast.TypeName(_typeFromName(owner)))
        return '/*lambda capturing ({})*/{}::{}'.format(', '.join(print_(c) for c in caps), target, name)

###############################################################################
# invokedynamic -> expression

_INTLIKE = (objtypes.IntTT, objtypes.ShortTT, objtypes.ByteTT, objtypes.CharTT)

def _flagFor(tt):
    if tt == objtypes.BoolTT:
        return True
    if tt in _INTLIKE:
        return False
    return None

def _concat(recipe, statics, params, argtts):
    pieces = [] # (expr, boolFlag)
    literal = []
    params = list(zip(params, list(argtts) + [None] * len(params)))
    statics = list(statics)

    def flush():
        if literal:
            pieces.append((ast.Literal(objtypes.StringTT, ''.join(literal)), None))
            del literal[:]

    for ch in recipe:
        if ch == '\x01':
            flush()
            p, tt = params.pop(0)
            pieces.append((p, _flagFor(tt)))
        elif ch == '\x02':
            flush()
            pieces.append((_constLiteral(statics.pop(0)), None))
        else:
            literal.append(ch)
    flush()

    if not pieces:
        return ast.Literal(objtypes.StringTT, '')

    # Make sure '+' means string concatenation: one of the first two operands must be a String
    def isStr(e): return e.dtype == objtypes.StringTT
    if not (isStr(pieces[0][0]) or (len(pieces) > 1 and isStr(pieces[1][0]))):
        pieces.insert(0, (ast.Literal(objtypes.StringTT, ''), None))
    if len(pieces) == 1:
        return pieces[0][0]

    expr, flag = pieces[0]
    expr = ast.StringConcat([expr, pieces[1][0]], [flag, pieces[1][1]])
    for p, f in pieces[2:]:
        expr = ast.StringConcat([expr, p], [None, f])
    return expr

def makeIndyExpr(op, params, ret_type):
    '''Returns a Java expression for an invokedynamic op, or None to use the default placeholder.'''
    try:
        return _makeIndyExpr(op, params, ret_type)
    except Exception: # never let a pretty-printing improvement break decompilation
        return None

def _makeIndyExpr(op, params, ret_type):
    index = getattr(op, 'index', None)
    if index is None:
        return None
    cls = op.parent.class_
    cpool = cls.cpool
    bs_id, name, desc = cpool.getArgs(index)
    table = _bootstrapTable(cls)
    if bs_id >= len(table):
        return None
    bsm_ref, argrefs = table[bs_id]
    handle = _resolveConst(cpool, bsm_ref)
    _, _, bowner, bname, bdesc = handle
    statics = [_resolveConst(cpool, i) for i in argrefs]
    argtts = objtypes.verifierToSynthetic_seq(parseMethodDescriptor(desc, unsynthesize=False)[0])

    if bowner == 'java/lang/invoke/StringConcatFactory':
        if bname == 'makeConcatWithConstants' and statics and statics[0][0] == 'String':
            return _concat(statics[0][1], statics[1:], params, argtts)
        if bname == 'makeConcat':
            return _concat('\x01' * len(params), [], params, argtts)

    if bowner == 'java/lang/invoke/LambdaMetafactory' and bname in ('metafactory', 'altMetafactory'):
        impl = statics[1]
        if impl[0] != 'MethodHandle':
            return None
        implHandle = impl[1:]
        kind, iowner, iname, idesc = implHandle
        if iowner == cls.name and iname.startswith('lambda$'):
            return LambdaExpr(ret_type, params, implHandle, cls.name)
        if len(params) > 1 or (params and kind not in _INSTANCE_KINDS):
            return None # captures that don't fit a method reference; leave as placeholder
        return MethodRefExpr(ret_type, params, implHandle, cls.name)

    if bowner == 'java/lang/runtime/ObjectMethods' and bname == 'bootstrap':
        return PseudoCall('record-generated', 'ObjectMethods.' + name, params, ret_type, kind='ObjectMethods')

    if bowner == 'java/lang/runtime/SwitchBootstraps' and bname in ('typeSwitch', 'enumSwitch'):
        labels = [_constLiteral(c) for c in statics]
        return PseudoCall('SwitchBootstraps.{}: index of first matching label'.format(bname), bname,
                          list(params) + labels, ret_type, kind='switch')

    simpleOwner = bowner.rpartition('/')[2]
    return PseudoCall('invokedynamic {}.{}'.format(simpleOwner, bname), name, params, ret_type)

###############################################################################
# Class level pass

def _iterStatements(block):
    stack = [block]
    while stack:
        scope = stack.pop()
        for item in scope.statements:
            yield item
            stack.extend(item.getScopes())

def _iterExprs(expr):
    stack = [expr]
    while stack:
        e = stack.pop()
        yield e
        stack.extend(e.params)

def _findNodes(md, types):
    if md.body is None:
        return
    for item in _iterStatements(md.body):
        if item.expr is not None:
            for e in _iterExprs(item.expr):
                if isinstance(e, types):
                    yield e

def _substitute(block, rdict):
    for item in _iterStatements(block):
        if item.expr is not None:
            item.expr = item.expr.replaceSubExprs(rdict)

def _castFunctionalReceivers(method_defs):
    '''`(x -> y).apply(1)` isn't valid Java: a lambda or method ref used as a receiver needs a cast
    giving it a target type, e.g. `((IntOp)(x -> y)).apply(1)`. This happens when a single-use
    variable holding the lambda gets inlined.'''
    for md in method_defs:
        for inv in _findNodes(md, ast.MethodInvocation):
            if not inv.hasLeft:
                continue
            recv = inv.params[0]
            inner = recv.params[0] if isinstance(recv, ast.Parenthesis) else recv
            if isinstance(inner, (LambdaExpr, MethodRefExpr)) and inner.dtype is not None:
                cast = ast.Cast(ast.TypeName(inner.dtype), ast.Parenthesis(inner))
                inv.params[0] = ast.Parenthesis(cast)

def _inlineLambdas(cls, method_defs):
    _castFunctionalReceivers(method_defs)
    byKey = {md.triple[1:]: md for md in method_defs}
    found = []
    counts = {}
    for md in method_defs:
        for node in _findNodes(md, LambdaExpr):
            key = node.handle[2], node.handle[3]
            found.append((node, md))
            counts[key] = counts.get(key, 0) + 1

    removed = set()
    for node, encl in found:
        key = node.handle[2], node.handle[3]
        lam = byKey.get(key)
        if lam is None or lam is encl or counts[key] != 1 or lam.body is None:
            continue
        # guard against cycles in namegen delegation
        gen, cyclic = encl.namegen, False
        while gen is not None:
            if gen is lam.namegen:
                cyclic = True
                break
            gen = gen.delegate
        if cyclic:
            continue

        caps = node.captures()
        decls = lam.paramDecls
        if len(caps) > len(decls):
            continue
        rdict = {}
        for decl, cap in zip(decls, caps):
            if isinstance(cap, (ast.Local, ast.Literal)):
                rdict[decl.local] = cap
            else:
                node.unsafeCaptures.append((decl.local, cap))
        if rdict:
            _substitute(lam.body, rdict)
        node.lambdaParams = decls[len(caps):]
        node.inlineDef = lam
        lam.namegen.delegate = encl.namegen
        removed.add(id(lam))

    return [md for md in method_defs if id(md) not in removed]

def _readRecord(cls):
    for name, data in (cls.attributes or []):
        if name == 'Record':
            count = struct.unpack_from('>H', data, 0)[0]
            pos, comps = 2, []
            for _ in range(count):
                n_i, d_i, attr_count = struct.unpack_from('>HHH', data, pos)
                pos += 6
                for _ in range(attr_count):
                    alen = struct.unpack_from('>L', data, pos + 2)[0]
                    pos += 6 + alen
                comps.append((cls.cpool.getArgsCheck('Utf8', n_i), cls.cpool.getArgsCheck('Utf8', d_i)))
            return comps
    return None

def _readPermits(cls):
    for name, data in (cls.attributes or []):
        if name == 'PermittedSubclasses':
            count = struct.unpack_from('>H', data, 0)[0]
            idxs = struct.unpack_from('>' + 'H' * count, data, 2)
            return [cls.cpool.getArgsCheck('Class', i) for i in idxs]
    return []

def _isObjectMethodsBody(md):
    if md.body is None or len(md.body.statements) != 1:
        return False
    stmt = md.body.statements[0]
    if not isinstance(stmt, ast.ReturnStatement) or stmt.expr is None:
        return False
    return any(isinstance(e, PseudoCall) and e.kind == 'ObjectMethods' for e in _iterExprs(stmt.expr))

def _isTrivialAccessor(md, comp, desc):
    if md.triple[1:] != (comp, '()' + desc) or md.body is None or len(md.body.statements) != 1:
        return False
    stmt = md.body.statements[0]
    e = stmt.expr if isinstance(stmt, ast.ReturnStatement) else None
    return isinstance(e, ast.FieldAccess) and e.name == comp

def _isCanonicalCtor(md, comps):
    desc = '(' + ''.join(d for _, d in comps) + ')V'
    if not md.isConstructor or md.triple[2] != desc or md.body is None:
        return False
    stmts = md.body.statements
    if len(stmts) != len(comps):
        return False
    for stmt, decl, (name, _) in zip(stmts, md.paramDecls, comps):
        if not isinstance(stmt, ast.ExpressionStatement) or not isinstance(stmt.expr, ast.Assignment):
            return False
        left, right = stmt.expr.params
        if not isinstance(left, ast.FieldAccess) or left.name != name or right is not decl.local:
            return False
    return True

def postprocessClass(cls, class_def):
    '''Runs after all methods are decompiled. Mutates class_def.'''
    try:
        class_def.methods = _inlineLambdas(cls, class_def.methods)
    except Exception:
        import traceback
        traceback.print_exc()

    try:
        comps = _readRecord(cls)
        if comps is not None and cls.supername == 'java/lang/Record':
            names = {n for n, _ in comps}
            class_def.recordComponents = [
                (ast.TypeName(objtypes.verifierToSynthetic(parseFieldDescriptor(d, unsynthesize=False)[0])), n)
                for n, d in comps]
            class_def.fields = [f for f in class_def.fields if 'static' in f.flagstr or f.name not in names]
            kept = []
            for md in class_def.methods:
                if md.triple[1] in ('toString', 'hashCode', 'equals') and _isObjectMethodsBody(md):
                    continue
                if any(_isTrivialAccessor(md, n, d) for n, d in comps):
                    continue
                if _isCanonicalCtor(md, comps):
                    continue
                kept.append(md)
            class_def.methods = kept
        permits = _readPermits(cls)
        if permits:
            class_def.permits = [ast.TypeName(objtypes.TypeTT(p, 0)) for p in permits]
    except Exception:
        import traceback
        traceback.print_exc()
    return class_def
