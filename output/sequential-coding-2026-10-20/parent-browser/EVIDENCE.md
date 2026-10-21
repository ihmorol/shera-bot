# Parent browser checkpoint

Observed with installed headless Chrome 155 against the built website at local port 3177. Login page was checked at 360, 768 and 1440 pixels with screenshots and DOM measurements. No horizontal overflow; the Google sign-in link was reached by keyboard at each width. Reduced-motion emulation was recognized by the browser. Parent visually inspected the 360 and 1440 screenshots.

Scope: unauthenticated login only. This does not verify real Google OAuth, authenticated Agent pages, live providers or full accessibility compliance. The initial smoke assertion incorrectly demanded 44px height; the existing Button default is 40px and no such requirement was located in the inspected design spec. The smoke now checks visibility and captures dimensions, rather than inventing a new product sizing requirement. Initial selector was also corrected to select the sign-in link rather than the wordmark.

Owned Next and Chrome processes were stopped by the smoke script. Browser logs, screenshots, script and results.json are beside this receipt.
