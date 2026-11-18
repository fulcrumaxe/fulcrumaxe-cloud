import { createElement as h } from "react";
import { LinkForm } from "./LinkForm";

export const metadata = { title: "Link a machine", robots: { index: false, follow: false } };

/**
 * ON-2: where a person types the code a machine shows. The page takes no input from its address: `?code=` (or anything else a link carries) is never read,
 * so the field is always empty and the person has to type the code from the machine in front of them. A link that filled it in would let anyone who can
 * send you a link get their own machine approved with one click.
 */
export default function LinkPage() {
  return h("main", null, h("h1", null, "Link a machine"), h("p", null, "Type the code your machine is showing. Do not link a code someone sent you."), h(LinkForm));
}
