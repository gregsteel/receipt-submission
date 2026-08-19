import { ReceiptCapture } from "@/components/ReceiptCapture";
import { getSession } from "@/lib/auth/session";
import { redirect } from "next/navigation";

export default async function Home() {
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }

  return <ReceiptCapture userEmail={session.email} />;
}
