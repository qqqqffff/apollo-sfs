import React from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useAuth } from '../auth';

export const Route = createFileRoute('/')({
  component: IndexComponent,
});

function IndexComponent() {
  const { isAuthenticated, logout } = useAuth();

  return (
    <div>
      <header className="bg-blue-600 text-white p-4">
        <nav className="flex justify-between">
          <div>
            <Link to="/" className="mr-4">Home</Link>
            {isAuthenticated && <Link to="/files" className="mr-4">Files</Link>}
          </div>
          <div>
            {isAuthenticated ? (
              <button onClick={logout} className="bg-red-500 px-4 py-2 rounded">Logout</button>
            ) : (
              <Link to="/login">Login</Link>
            )}
          </div>
        </nav>
      </header>
      <main className="p-4">
        <h1>Welcome to Apollo SFS</h1>
        {isAuthenticated && <p>You are logged in.</p>}
      </main>
    </div>
  );
}
