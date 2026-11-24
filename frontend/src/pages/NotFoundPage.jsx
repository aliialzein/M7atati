import { useAuth } from "../features/auth/AuthProvider.jsx";
import { Button, Title } from "../components/ui.jsx";

export default function NotFoundPage() {
  const { user } = useAuth();
  return (
    <>
      <Title title="Page not found" />
      <Button to={user ? "/home" : "/"}>Return to SmartStation</Button>
    </>
  );
}
