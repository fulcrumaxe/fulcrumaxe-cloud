import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { opsPool } from "../lib/db";
import { requireStaff } from "../lib/requireStaff";
import { SignOutButton } from "./SignOutButton";

export default async function HomePage() {
  const staff = await requireStaff(await headers(), opsPool());
  if (!staff) redirect("/login");
  return (
    <main>
      <h1>Operator console</h1>
      <p>You are signed in. The console&apos;s pages arrive in later changes.</p>
      <SignOutButton />
    </main>
  );
}
