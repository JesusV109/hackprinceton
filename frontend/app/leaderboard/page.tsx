"use client";
export const dynamic = "force-dynamic";

import { db } from "@/lib/firebase";
import { collection, query, orderBy, onSnapshot } from "firebase/firestore";
import { useEffect, useState } from "react";

export default function LeaderboardPage() {
  const [players, setPlayers] = useState<any[]>([]);

  useEffect(() => {
    const q = query(
      collection(db, "players"),
      orderBy("completedCount", "desc"),
      orderBy("accuracy", "desc")
    );

    return onSnapshot(q, (snap) => {
      setPlayers(
        snap.docs.map((d) => ({
          id: d.id,
          ...d.data(),
        }))
      );
    });
  }, []);

  return (
    <main className="flex min-h-screen flex-col items-center justify-start bg-black text-white p-8">
      <h1 className="text-4xl font-bold mb-6">Global Leaderboard</h1>

      <div className="w-full max-w-4xl overflow-x-auto">
        <table className="w-full border border-gray-800 rounded-lg overflow-hidden">
          <thead>
            <tr className="bg-gray-900 text-left text-white text-sm">
              <th className="p-3">#</th>
              <th className="p-3">Player</th>
              <th className="p-3">Completed</th>
              <th className="p-3">Attempts</th>
              <th className="p-3">Accuracy</th>
              <th className="p-3">Last Pose</th>
              <th className="p-3">Updated</th>
            </tr>
          </thead>

          <tbody>
            {players.map((p: any, idx) => (
              <tr
                key={p.id}
                className="border-t border-gray-800 text-sm hover:bg-gray-800/30 transition"
              >
                <td className="p-3">{idx + 1}</td>
                <td className="p-3 font-semibold">{p.name}</td>
                <td className="p-3">{p.completedCount || 0}</td>
                <td className="p-3">{p.totalAttempts || 0}</td>
                <td className="p-3">
                  {p.accuracy ? (p.accuracy * 100).toFixed(0) + "%" : "0%"}
                </td>
                <td className="p-3 capitalize">{p.lastPose || "—"}</td>
                <td className="p-3">
                  {p.lastUpdated?.toDate
                    ? p.lastUpdated.toDate().toLocaleString()
                    : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
