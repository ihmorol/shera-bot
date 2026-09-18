/**
 * S01 placeholder page. It exists to prove the Next.js toolchain builds inside
 * the workspace; it deliberately carries no product UI. S08 builds the real
 * chat-first shell against docs/UI_DESIGN.md and the impeccable craft floor.
 */
export default function Page() {
  return (
    <main>
      <h1>Shera Bot</h1>
      <p>
        Client shell placeholder. The Agent chat UI is built in S08 on the S02 contracts in
        <code> @shera-bot/contracts</code>.
      </p>
    </main>
  );
}
