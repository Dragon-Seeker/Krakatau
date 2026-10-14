# Override this to rename classes
class DefaultVisitor(object):
    def visit(self, obj):
        return obj.print_(self, self.visit)

    # Experimental - don't use!
    def toTree(self, obj):
        if obj is None:
            return None
        return obj.tree(self, self.toTree)

    def className(self, name): return name
    def methodName(self, cls, name, desc): return name
    def fieldName(self, cls, name, desc): return name


MARK_START, MARK_END = '\ue000', '\ue001'

class MappingVisitor(DefaultVisitor):
    """Prints like DefaultVisitor, but every AST node tagged with a bytecode position (bc_pos)
    gets an invisible marker before its text. finish() strips the markers and returns
    (source, [(owner, name, desc, offset, line)]), line being 1-based in the returned source."""
    def __init__(self):
        self.positions = []

    def visit(self, obj):
        text = obj.print_(self, self.visit)
        pos = getattr(obj, 'bc_pos', None)
        if pos is None:
            return text
        self.positions.append(pos)
        return '{}{}{}{}'.format(MARK_START, len(self.positions) - 1, MARK_END, text)

    def finish(self, text):
        out, mapping, line, i = [], [], 1, 0
        while True:
            j = text.find(MARK_START, i)
            chunk = text[i:] if j < 0 else text[i:j]
            out.append(chunk)
            line += chunk.count('\n')
            if j < 0:
                break
            k = text.index(MARK_END, j)
            (owner, name, desc), off = self.positions[int(text[j+1:k])]
            mapping.append((owner, name, desc, off, line))
            i = k + 1
        return ''.join(out), mapping
