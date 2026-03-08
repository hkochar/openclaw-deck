"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function UsageRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/costs");
  }, [router]);
  return <div className="loading">Redirecting to Costs…</div>;
}
