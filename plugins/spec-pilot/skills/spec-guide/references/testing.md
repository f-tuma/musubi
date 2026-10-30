# Fast tests, UI checks and polish

Fast scenarios call the application's actual functions/components and substitute time, network and persistence at existing ports. A second implementation of business rules creates a misleading oracle. Derive expectations from the requirements, and check an important test can fail on a corresponding controlled defect.

Expose initial state, action and observable outcome in code, JSON, YAML or another useful representation. For UI state checks the representation can expose actual state and available actions without rendering every edit-loop iteration. Use readable failures, deterministic scenario selection, resettable data, meaningful process exit status and measured iteration time. A particular serialization is optional.

| Evidence | Scope |
| --- | --- |
| Types/lint | Mechanical structure and selected static rules |
| Fast production-logic scenarios | Selected behavior against controlled dependency contracts |
| Contract/integration checks | Actual affected persistence, serialization, authentication or service boundaries |
| Browser/device flow | Rendered UI, interactions and its actual wiring; record mocked boundaries |
| Visual review | Layout, hierarchy, states, theme and responsive result |
| Live/smoke observation | A specific real account, provider, artifact or environment |

Unknown IDs, empty suites, skipped required cases and unconsumed fixtures must not be reported as completed scenarios. A fixture-backed browser does not verify database authorization or provider writes. Screenshots do not verify business rules or keyboard/focus behavior. A live account does not certify every environment. Use project-native tools; Vitest/Playwright are examples, not dependencies of this plugin.

For UI read the existing design system, tokens, scoped instructions and real component references. Keep one token authority. DESIGN.md may express it or project it, but does not have to replace an established token package. Review comparable state, data, viewport and theme. Explain changes to golden files and screenshot references.

Polish includes relevant first-use, empty, loading, error, retry and success states; action/copy clarity, component consistency, narrow layouts, keyboard/focus, realistic data and documentation. A person without the design conversation can reveal first-use problems; absent observation remains a limitation. A new feature found during polish becomes a scoped change. Re-run affected behavior after visual fixes.

Record exact commands and outcomes, checked revision/inputs, environment and replaced boundaries. Test counts and coverage alone are not acceptance. Required CI checks and final-state review remain in place.
