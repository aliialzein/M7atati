import { createContext, useContext, useEffect, useState } from "react";
import { api, restoreSession, signOut } from "../../api/client.js";

const Auth = createContext(null);

export function AuthProvider({ children }) {
  const [session, setSession] = useState({ loading: true });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    function update(event) {
      setSession({ user: event.detail });
    }
    window.addEventListener("smartstation-session", update);
    restoreSession().then(
      (user) => {
        if (active) setSession({ user });
      },
      (error) => {
        if (active) setSession({ error });
      },
    );
    return () => {
      active = false;
      window.removeEventListener("smartstation-session", update);
    };
  }, [attempt]);

  async function authenticate(kind, credentials) {
    const { user } = await api(`/auth/${kind}`, {
      method: "POST",
      body: credentials,
      public: true,
    });
    setSession({ user });
  }

  async function logout() {
    await signOut();
    setSession({ user: null });
  }

  return (
    <Auth.Provider
      value={{
        ...session,
        authenticate,
        logout,
        retry: () => {
          setSession({ loading: true });
          setAttempt((value) => value + 1);
        },
      }}
    >
      {children}
    </Auth.Provider>
  );
}

export function useAuth() {
  return useContext(Auth);
}
