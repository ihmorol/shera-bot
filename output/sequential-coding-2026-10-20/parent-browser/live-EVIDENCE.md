# Parent live browser verification

Real installed Chrome drove the built Next website at 360, 768 and 1440 pixels through the real control plane, PostgreSQL session store, managed runtime and SQLite journal. The test account/session was seeded in a disposable database; only the container engine was simulated. No real Google login or model call is claimed.

Assertions passed: no horizontal overflow; composer available; a browser-entered user message received an authoritative message.appended frame with the session display name; refresh shows the message once; forced client close causes a new same-origin socket and NEW replay acknowledgement; message stays visible once; real CSRF-protected Auth.js signout closes all streams and subsequent session read returns401. Every browser socket URL used the web origin and fixed live path. Parent visually inspected live-message-after-reconnect.png.

Evidence: live-results.json, live-run.log and live-exit.txt=0. Initial probe failures were a missing navigation null guard and a too-weak reconnect assertion, both corrected before this passing run. The build completed successfully; its Python output wrapper later failed printing a Unicode symbol on a cp1252 terminal. Final numeric build exit verification remains with the executor/parent integration gate.

This proves transport behavior with a seeded session and test data. It does not prove live providers, actual OAuth login, Docker replacement, all product screens or complete accessibility acceptance. The real-mode sidebar still contains existing fixture Operation chats, recorded in the baseline B11/product backlog.
