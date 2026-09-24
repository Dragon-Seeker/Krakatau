#!/usr/bin/env python3
"""Build a small "stub" jar of library classes for the decompiler.

Krakatau only needs each library class's name, superclass, interfaces and access flags
(for type inference and cast placement), so every method, field and attribute is dropped.
A full JDK java.base becomes ~1 MB instead of ~15 MB, which matters when it has to be
downloaded into a browser.

Usage:
  python3 tools/make_stubs.py --jdk $JAVA_HOME -o jdk-stubs.jar
  python3 tools/make_stubs.py minecraft-client.jar fabric-loader.jar -o mc-stubs.jar
"""
import argparse, os, struct, subprocess, sys, tempfile, zipfile

_CP_SIZES = {3: 4, 4: 4, 5: 8, 6: 8, 7: 2, 8: 2, 9: 4, 10: 4, 11: 4, 12: 4, 15: 3, 16: 2, 17: 4, 18: 4, 19: 2, 20: 2}

def stub(data):
    '''Return a header-only classfile, or None if data isn't a usable classfile.'''
    if data[:4] != b'\xca\xfe\xba\xbe':
        return None
    minor, major, count = struct.unpack_from('>HHH', data, 4)
    pos, utf8, classes = 10, {}, {}
    i = 1
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
    flags, this, sup, icount = struct.unpack_from('>HHHH', data, pos)
    ifaces = struct.unpack_from('>' + 'H' * icount, data, pos + 8)
    if flags & 0x8000: # module-info
        return None

    names = [utf8[classes[this]]] + ([utf8[classes[sup]]] if sup else []) + [utf8[classes[x]] for x in ifaces]
    pool = []
    for n in names:
        pool.append(b'\x01' + struct.pack('>H', len(n)) + n)          # Utf8
        pool.append(b'\x07' + struct.pack('>H', len(pool)))            # Class -> preceding Utf8 (1-based)
    idx = lambda k: 2 * (k + 1)                                        # index of k-th Class entry
    out = b'\xca\xfe\xba\xbe' + struct.pack('>HHH', minor, major, len(pool) + 1) + b''.join(pool)
    out += struct.pack('>HHH', flags, idx(0), idx(1) if sup else 0)
    rest = range(2 if sup else 1, len(names))
    out += struct.pack('>H', len(rest)) + b''.join(struct.pack('>H', idx(k)) for k in rest)
    out += b'\x00\x00' * 3 # fields, methods, attributes
    return out

def iter_classes(path):
    if os.path.isdir(path):
        for root, _, files in os.walk(path):
            for f in files:
                if f.endswith('.class'):
                    full = os.path.join(root, f)
                    with open(full, 'rb') as fh:
                        yield os.path.relpath(full, path).replace(os.sep, '/'), fh.read()
    else:
        with zipfile.ZipFile(path) as z:
            for n in z.namelist():
                if n.endswith('.class') and not n.startswith('META-INF/'):
                    yield n, z.read(n)

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('inputs', nargs='*', help='jars or class directories')
    ap.add_argument('--jdk', help='JDK home; extracts its runtime image with jimage')
    ap.add_argument('--modules', default='*', help="with --jdk: comma separated modules, default all (e.g. java.base,java.desktop)")
    ap.add_argument('-o', '--out', required=True)
    args = ap.parse_args()

    inputs = list(args.inputs)
    tmp = None
    if args.jdk:
        tmp = tempfile.mkdtemp()
        cmd = [os.path.join(args.jdk, 'bin', 'jimage'), 'extract', '--dir', tmp]
        if args.modules != '*':
            cmd += ['--include', ','.join('regex:/{}/.*'.format(m.replace('.', r'\.')) for m in args.modules.split(','))]
        subprocess.check_call(cmd + [os.path.join(args.jdk, 'lib', 'modules')])
        inputs += [os.path.join(tmp, m) for m in sorted(os.listdir(tmp))]

    seen, written, skipped = set(), 0, 0
    with zipfile.ZipFile(args.out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as out:
        for inp in inputs:
            for name, data in iter_classes(inp):
                if name in seen:
                    continue
                try:
                    s = stub(data)
                except Exception:
                    s = None
                if s is None:
                    skipped += 1
                    continue
                seen.add(name)
                out.writestr(name, s)
                written += 1
    print('{} classes stubbed ({} skipped) -> {} ({:.1f} KB)'.format(written, skipped, args.out, os.path.getsize(args.out) / 1024))

if __name__ == '__main__':
    main()
