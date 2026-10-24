import type { Metadata } from "next";

import { NewOperationSurface } from "@/components/operations/operation-chat-surface";

export const metadata: Metadata = {
  title: "New Operation",
};

/**
 * S6 ad-hoc Operation creation (UI_DESIGN §S6, D29/D41). S13 chunk 4 wires the
 * REAL form over the live workspace roster once the container is ready; the
 * container gate owns every earlier lifecycle state.
 */
export default function NewOperationPage() {
  return <NewOperationSurface />;
}
