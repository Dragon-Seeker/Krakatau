public class Lam {
    interface IntOp { int apply(int x); }
    interface BiOp { int apply(int a, int b); }
    interface StrFn { String f(String s); }
    interface Maker { Object make(); }
    interface ArrMaker { int[] make(int n); }
    interface Act { void run(); }

    static class Base { String greet(String s) { return "base:" + s; } }
    static class Child extends Base {
        String greet(String s) { return "child:" + s; }
        StrFn viaSuper() { return super::greet; }
    }

    int field = 10;
    static StringBuilder log = new StringBuilder();
    static final IntOp SQUARE = x -> x * x;

    static int twice(IntOp op, int v) { return op.apply(op.apply(v)); }

    int instanceCapture(int k) {
        int local = k + 1;
        IntOp op = x -> x + local + this.field;
        return op.apply(5);
    }

    static int nested(int a) {
        int b = a * 2;
        BiOp outer = (x, y) -> {
            IntOp inner = z -> z + x + b;
            return inner.apply(y) * 2;
        };
        return outer.apply(3, 4);
    }

    static int blockLoop(int n) {
        int s = 7;
        IntOp op = i -> {
            int total = 0;
            for (int j = 0; j < i; j++) {
                if (j % 2 == 0) total += j * s; else total -= 1;
            }
            return total;
        };
        return op.apply(n);
    }

    static String refs(String in) {
        StrFn trim = String::trim;
        StrFn upper = String::toUpperCase;
        String prefix = "<";
        StrFn bound = prefix::concat;
        StrFn stat = Lam::wrap;
        Maker mk = StringBuilder::new;
        ArrMaker arr = int[]::new;
        StrFn sup = new Child().viaSuper();
        return bound.f(upper.f(trim.f(in))) + stat.f("w") + mk.make().getClass().getSimpleName() + arr.make(3).length + sup.f("z");
    }

    static String wrap(String s) { return "[" + s + "]"; }

    static void voidLambda(int n) {
        Act a = () -> log.append("ran").append(n);
        a.run();
        Act b = () -> {};
        b.run();
    }

    public static void main(String[] args) {
        System.out.println(twice(SQUARE, 3));
        System.out.println(new Lam().instanceCapture(2));
        System.out.println(nested(5));
        System.out.println(blockLoop(6));
        System.out.println(refs("  hi "));
        voidLambda(4);
        System.out.println(log);
        int x = 100;
        IntOp shadowSafe = y -> y + x;
        System.out.println(shadowSafe.apply(1));
    }
}
