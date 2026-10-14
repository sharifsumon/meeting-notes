import "server-only";
import { redirect } from "next/navigation";
import { auth } from "@/auth";

/** Returns the signed-in user's id, or sends them to the sign-in page. */
export async function requireUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) redirect("/");
  return session.user.id;
}
