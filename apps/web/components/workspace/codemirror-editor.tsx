"use client";

import { EditorState, Compartment, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useRef, type ReactElement } from "react";

/**
 * The client-only CodeMirror 6 mount surface (chunk 5; the open-source
 * adoption recorded in the slice's E-note — codemirror + @codemirror/state,
 * @codemirror/view, @codemirror/commands, @codemirror/language, all MIT).
 *
 * OWNERSHIP SPLIT: this component owns ONLY the EditorView lifecycle —
 * create into the host, stream doc changes out, reconfigure the editable
 * facets when the D6 lease lock flips, destroy on the way out. The editor's
 * extensions (line numbers, the Mod-s save keymap, history) are built by the
 * Editor tab and arrive as props. The view is created once per document
 * (a fresh state per doc — the guide's recommendation, so undo history never
 * leaks across files) and reconfigured in place when the lock changes, so a
 * refused save never throws away the user's draft.
 *
 * The editor's theme is token-derived only (§2.1: raw color values live in
 * globals.css alone). It themes the browser-surface details the craft floor
 * calls out: caret, selection, gutters, focus ring.
 */
const editorTheme = EditorView.theme({
  "&": {
    color: "var(--color-text)",
    backgroundColor: "transparent",
    height: "100%",
    fontSize: "var(--text-sm)",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: "1.6",
  },
  ".cm-content": {
    caretColor: "var(--color-sky)",
  },
  ".cm-cursor": {
    borderLeftColor: "var(--color-sky)",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--color-brand) 35%, transparent)",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--color-muted)",
    border: "none",
    borderRight: "1px solid var(--color-line)",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in srgb, var(--color-surface-elevated) 55%, transparent)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--color-text)",
  },
  "&.cm-focused": {
    outline: "2px solid var(--color-sky)",
    outlineOffset: "-2px",
  },
});

/**
 * The editable/read-only compartment — a module-level singleton is safe: a
 * Compartment carries no per-view state, each EditorState resolves its own
 * facet value, and the lock flip reconfigures through the same reference.
 */
const editable = new Compartment();

export function CodeMirrorSurface({
  content,
  locked,
  extensions,
  onDocChange,
}: {
  content: string;
  locked: boolean;
  extensions: Extension[];
  onDocChange: (doc: string) => void;
}): ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Latest extensions/callbacks without re-creating the view on identity
  // changes. The ref is written in an effect (never during render).
  const latest = useRef({ extensions, onDocChange });
  useEffect(() => {
    latest.current = { extensions, onDocChange };
  });

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const state = EditorState.create({
      doc: content,
      extensions: [
        editorTheme,
        editable.of([EditorView.editable.of(!locked), EditorState.readOnly.of(locked)]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) latest.current.onDocChange(update.state.doc.toString());
        }),
        ...latest.current.extensions,
      ],
    });
    const view = new EditorView({ state, parent: host });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Creation is per-document by design (fresh undo history per file);
    // extensions and callbacks ride the ref, the lock rides the compartment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: editable.reconfigure([
        EditorView.editable.of(!locked),
        EditorState.readOnly.of(locked),
      ]),
    });
  }, [locked]);

  return <div ref={hostRef} className="min-h-0 flex-1 overflow-auto text-sm" />;
}
