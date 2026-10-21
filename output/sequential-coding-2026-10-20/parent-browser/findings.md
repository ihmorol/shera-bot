# Parent browser and real-app findings

Baseline: bc8efbbd04a7e5791938b437b3942b59433cad68; existing built web output from Task 2, before Task 4 transport build. Disposable QA sessions/accounts only.

## B19: runtime POST bodies never parsed by actual control plane

Confirmed by real PostgreSQL/Auth.js/managed-runtime probe: a valid settings command through the actual app gets HTTP 403 RUNTIME_TENANT_MISMATCH with category policy. The actual route mounts createRuntimeApiProxy without JSON parsing, while its focused tests install express.json themselves. GET works. This blocks settings and message commands. Assigned to the current Task 4 executor because browser chat send depends on it. Evidence: cp-post-before-task-4.json and real-fixture.mjs.

## B20: built Next request origin differs from browser origin

Confirmed by an identical real command through the built web server at 127.0.0.1:3177. Browser-correct Origin http://127.0.0.1:3177 gets the web proxy's 403 unauthorized response. An artificial Origin http://localhost:3177 gets through that gate to the separate CP parser failure; omitting Origin also gets through. The web proxy compares against NextRequest.url's internal localhost origin. Preserve foreign-origin rejection while binding validation to a trusted deployment origin. Assigned to Task 4 as a browser-send dependency. Evidence: web-post-before-task-4.json and post-boundary-probe.mjs.

## Unconfirmed settings-reset suspicion

Local editor drafts use useState(entry.value) and may remain stale after authoritative reset. Browser save is blocked by B19/B20, so this is a code-review suspicion, not a reproduced product finding. Repeat the settings-reset probe only after the two command-boundary fixes. Earlier probe failures are retained in logs; they do not prove the reset bug.

## B21: confirmed stale instructions editor after reset

The follow-up probe used the legitimate localhost web origin against the baseline built UI and the Task 4 working-tree CP JSON parser. Saving instructions now succeeds. Reset then returns the persisted value to null, while the visible textarea still contains the old instructions. Receipt: settings-reset-localhost-results.json; screenshot: settings-reset.png. This confirms the earlier suspicion. Parent will delegate the smallest settings-editor repair after Task 4 is reviewed and integrated, without parallel source edits.
