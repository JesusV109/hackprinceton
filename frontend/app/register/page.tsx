"use client";

import { useState } from "react";
import { db, createNewAnonymousSession } from "@/lib/firebase";
import { doc, setDoc, serverTimestamp } from "firebase/firestore";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export default function RegisterPage() {
  const [name, setName] = useState("");
  const router = useRouter();

  async function saveName() {
    if (!name.trim()) return;
    const trimmed = name.trim();
    // create a fresh anonymous session (new UID) so each registration becomes a new player
    try {
      const uid = await createNewAnonymousSession();
      const ref = doc(db, "players", uid);
      await setDoc(ref, { name: trimmed, lastUpdated: serverTimestamp() }, { merge: true });
    } catch (e) {
      console.error("failed to create anonymous session or save name", e);
    }
    // navigate to play regardless
    router.push("/play");
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-black text-white px-6">
      <h1 className="text-4xl font-bold mb-6">Register</h1>

      <div className="w-full max-w-sm space-y-4">
        <Input
          placeholder="Enter your name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            // save on blur as a best-effort fallback: create a new anonymous session and store name
            if (name.trim()) {
              createNewAnonymousSession()
                .then((uid) => setDoc(doc(db, "players", uid), { name: name.trim(), lastUpdated: serverTimestamp() }, { merge: true }))
                .catch(console.error);
            }
          }}
          className="text-black"
        />

        <div className="flex items-center justify-between">
          <div className="text-sm text-gray-300">Preview: <span className="text-white font-medium">{name || "(empty)"}</span></div>
          <Button type="button" onClick={saveName} className="w-32 py-3 text-lg">
            Continue
          </Button>
        </div>
      </div>
    </main>
  );
}
