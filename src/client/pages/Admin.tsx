import { useEffect, useState } from "react";
import { api } from "../lib/api";

interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
  createdAt: number;
}

export function Admin() {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<{ users: AdminUser[] }>("/admin/users")
      .then((data) => setUsers(data.users))
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load users"));
  }, []);

  return (
    <div>
      <h1 className="mb-6 text-xl font-semibold">Users</h1>

      {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

      {!users ? (
        <p className="text-sm text-slate-600">Loading…</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-edge">
          <table className="w-full text-sm">
            <thead className="bg-surface text-left text-slate-600">
              <tr>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Email</th>
                <th className="px-4 py-2 font-medium">Admin</th>
                <th className="px-4 py-2 font-medium">Joined</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-t border-edge">
                  <td className="px-4 py-2">{u.displayName}</td>
                  <td className="px-4 py-2 font-mono text-slate-700">{u.email}</td>
                  <td className="px-4 py-2">{u.isAdmin ? "Yes" : ""}</td>
                  <td className="px-4 py-2 text-slate-500">{new Date(u.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
