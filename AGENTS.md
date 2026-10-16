# Scope for the original-bytecode port

Continue work on `main`, as explicitly requested by the user after the repository transition.
Preserve `milestone/m1`, `work/original-bytecode-browser-port` and the orphan backup branches unless the user requests another change.
Do not open pull requests unless requested. Use conventional commit messages and push logical verified increments to `main`.
Use the configured GitHub App identity. Do not fall back to personal authentication.

Preserve installed game files and native saves. Do not start the original game or server.
Keep proprietary inputs, generated WASM, downloaded tools, raw inspection logs, and local handoffs untracked.
Original game classes must remain unchanged. Adapters and real browser host-service implementations are allowed.
Do not replace gameplay behavior with stubs or claim playability from compilation alone.

Use the actual JVM/browser comparisons in README.md, TEAVM.md and verify-host.mjs as regression gates.
Keep compile-only failures separate from browser passes. Inspect initialization before executing a new original-code closure.
Update COMPATIBILITY.md and PORTING.md when the tested scope or next blocker changes.
