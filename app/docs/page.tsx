"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function DocsRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/knowledge#docs");
  }, [router]);
  return <div className="loading">Redirecting to Knowledge…</div>;
}
