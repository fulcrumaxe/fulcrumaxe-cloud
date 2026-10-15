import { EnrollForm } from "./EnrollForm";

export default async function EnrollPage({ searchParams }: { searchParams: Promise<{ token?: string | string[] }> }) {
  const { token } = await searchParams;
  return (
    <main>
      <h1>Enroll a passkey</h1>
      {typeof token === "string" && token !== "" ? <EnrollForm token={token} /> : <p>This link has no enrollment token. Ask for a new one.</p>}
    </main>
  );
}
