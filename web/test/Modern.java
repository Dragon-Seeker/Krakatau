import java.util.*;
import java.util.function.*;

public class Modern {
    record Point(int x, int y) {}
    sealed interface Shape permits Circle, Square {}
    record Circle(double r) implements Shape {}
    record Square(double s) implements Shape {}

    static String concat(String name, int n) { return "Hello " + name + " #" + n; }

    static double area(Shape s) {
        return switch (s) {
            case Circle c -> Math.PI * c.r() * c.r();
            case Square q -> q.s() * q.s();
        };
    }

    static int len(Object o) {
        if (o instanceof String str && !str.isEmpty()) return str.length();
        return -1;
    }

    static int day(String d) {
        return switch (d) { case "mon" -> 1; case "tue" -> 2; default -> { yield 0; } };
    }

    static List<String> lambdas(List<String> in, int min) {
        Function<String,String> up = String::toUpperCase;
        return in.stream().filter(s -> s.length() > min).map(up).toList();
    }

    static String text() {
        return """
            multi
            line
            """;
    }

    final int v;
    Modern(int v) {
        if (v < 0) throw new IllegalArgumentException();  // flexible constructor body (Java 25)
        super();
        this.v = v;
    }
}
