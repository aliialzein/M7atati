import { Link, NavLink, Outlet } from "react-router-dom";
import { useAction } from "../api/hooks.js";
import { useAuth } from "../features/auth/AuthProvider.jsx";
import { features } from "../app/access.js";
import { Badge, Button, Status } from "./ui.jsx";
import { humanize } from "../lib/format.js";
import logo from "../assets/home/ec4c9.png";
import home from "../assets/home/81627.svg";
import fuel from "../assets/home/9cae5.svg";
import team from "../assets/home/f6635.svg";
import reports from "../assets/home/1d4c4.svg";
import settings from "../assets/home/c0ce9.svg";

const icons = { home, fuel, team, reports, settings, orders: reports };

export default function Layout() {
  const { user, logout } = useAuth();
  const action = useAction();
  const links = [
    ...(user ? [{ path: "/home", label: "Home", icon: "home" }] : []),
    ...features.filter((feature) => feature.show(user)),
  ];
  return (
    <div className="shell">
      <a href="#content" className="skip">
        Skip to content
      </a>
      <aside className="sidebar">
        <Link className="sidebar-brand" to={user ? "/home" : "/orders/new"}>
          <img src={logo} alt="" />
          <span>
            SmartStation<small>ENERGY &amp; LOGISTICS</small>
          </span>
        </Link>
        <nav aria-label="Main navigation">
          {links.map(({ path, label, icon }) => (
            <NavLink key={path} to={path} end>
              <img src={icons[icon]} alt="" />
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="workspace">
        <header className="workspace-header">
          <span className="workspace-name">Ma7atati</span>
          <div className="actions">
            {user ? (
              <>
                <Link className="identity" to="/profile">
                  {user.name}
                  <small>{humanize(user.role)}</small>
                </Link>
                <Button
                  disabled={action.pending}
                  onClick={() => action.run(logout)}
                >
                  Sign out
                </Button>
              </>
            ) : (
              <Button to="/">Sign in</Button>
            )}
          </div>
        </header>
        <main id="content" tabIndex={-1}>
          <Status action={action} />
          <Outlet />
        </main>
        <footer className="workspace-footer">
          SmartStation OS {user && <Badge>{humanize(user.role)}</Badge>}
        </footer>
      </div>
    </div>
  );
}
