"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function MemoryRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/knowledge#memory");
  }, [router]);
  return <div className="loading">Redirecting to Knowledge…</div>;
}
