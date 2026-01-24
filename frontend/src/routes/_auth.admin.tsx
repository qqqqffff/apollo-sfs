import React, { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useAuth } from '../auth';
import { useQuery, useMutation } from '@tanstack/react-query';

export const Route = createFileRoute('/_auth/admin')({
  component: AdminComponent,
});

function AdminComponent() {
  const { isAdmin, token } = useAuth();
  const [newUser, setNewUser] = useState({ username: '', email: '', password: '' });
  const [quotaUser, setQuotaUser] = useState({ userId: '', quota: '' });

  // Mock metrics - in real app, use a service
  const { data: metrics } = useQuery({
    queryKey: ['admin-metrics'],
    queryFn: () => fetch('/api/v1/admin/metrics', {
      headers: { Authorization: `Bearer ${token}` },
    }).then(res => res.json()).catch(() => ({ users: 10, files: 100 })),
  });

  const createUserMutation = useMutation({
    mutationFn: (user: any) => fetch('/api/v1/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(user),
    }).then(res => res.json()),
  });

  const setQuotaMutation = useMutation({
    mutationFn: ({ userId, quota }: any) => fetch(`/api/v1/admin/quota/${userId}?quota=${quota}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
    }).then(res => res.json()),
  });

  if (!isAdmin) {
    return <div>Access denied</div>;
  }

  const handleCreateUser = () => {
    createUserMutation.mutate(newUser);
  };

  const handleSetQuota = () => {
    setQuotaMutation.mutate({ userId: quotaUser.userId, quota: parseInt(quotaUser.quota) });
  };

  return (
    <div className="p-4">
      <h1 className="text-2xl mb-4">Admin Dashboard</h1>
      <div className="mb-8">
        <h2 className="text-xl mb-2">Metrics</h2>
        <p>Users: {metrics?.users}</p>
        <p>Files: {metrics?.files}</p>
      </div>
      <div className="mb-8">
        <h2 className="text-xl mb-2">Create User</h2>
        <input
          type="text"
          placeholder="Username"
          value={newUser.username}
          onChange={(e) => setNewUser({ ...newUser, username: e.target.value })}
          className="border p-2 mr-2"
        />
        <input
          type="email"
          placeholder="Email"
          value={newUser.email}
          onChange={(e) => setNewUser({ ...newUser, email: e.target.value })}
          className="border p-2 mr-2"
        />
        <input
          type="password"
          placeholder="Password"
          value={newUser.password}
          onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
          className="border p-2 mr-2"
        />
        <button onClick={handleCreateUser} className="bg-blue-500 text-white px-4 py-2">Create</button>
      </div>
      <div>
        <h2 className="text-xl mb-2">Set User Quota</h2>
        <input
          type="text"
          placeholder="User ID"
          value={quotaUser.userId}
          onChange={(e) => setQuotaUser({ ...quotaUser, userId: e.target.value })}
          className="border p-2 mr-2"
        />
        <input
          type="number"
          placeholder="Quota (bytes)"
          value={quotaUser.quota}
          onChange={(e) => setQuotaUser({ ...quotaUser, quota: e.target.value })}
          className="border p-2 mr-2"
        />
        <button onClick={handleSetQuota} className="bg-blue-500 text-white px-4 py-2">Set Quota</button>
      </div>
    </div>
  );
}
