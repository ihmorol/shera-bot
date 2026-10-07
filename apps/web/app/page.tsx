import { redirect } from "next/navigation";

import { routes } from "@/lib/routes";

/** The route map (UI_DESIGN §3.1) has no `/` screen — entry is the login route. */
export default function Page() {
  redirect(routes.login());
}
