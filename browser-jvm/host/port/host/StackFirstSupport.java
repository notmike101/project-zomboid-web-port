package port.host;

import java.util.NoSuchElementException;
import java.util.Stack;

/** Java 21 List.removeFirst default sequence for the original exact Stack receiver. */
public final class StackFirstSupport {
    private StackFirstSupport() { }

    public static <E> E removeFirst(Stack<E> stack) {
        if (stack.getClass() != Stack.class) {
            throw new UnsupportedOperationException("Unqualified Stack.removeFirst receiver: "
                    + stack.getClass().getName());
        }
        // JDK 25 Stack inherits List's default: two individually synchronized Vector calls.
        // An outer monitor would strengthen the original operation's concurrency semantics.
        if (stack.isEmpty()) throw new NoSuchElementException();
        return stack.remove(0);
    }
}
