import { useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { useAction } from "../../api/hooks.js";
import { useAuth } from "../../features/auth/AuthProvider.jsx";
import { Status } from "../../components/ui.jsx";
import Canopy from "./Canopy.jsx";
import "./AuthForm.css";
import logo from "../../assets/logo-pump.svg";
import emblem from "../../assets/emblem-drop.svg";
import eye from "../../assets/eye.svg";
import arrow from "../../assets/arrow-right.svg";

export default function AuthForm({ register = false }) {
  const { user, authenticate } = useAuth();
  const [visible, setVisible] = useState(false);
  const action = useAction();
  if (user) return <Navigate to="/home" replace />;
  return (
    <div className="signin">
      <header className="header">
        <div className="header__inner">
          <Link to="/" className="brand">
            <span className="brand__logo">
              <img src={logo} alt="" width="11" height="12" />
            </span>
            <span className="brand__title">
              SmartStation <small className="eyebrow">OS</small>
            </span>
          </Link>
          <Link to="/orders/new" className="eyebrow">
            Order fuel as guest →
          </Link>
        </div>
      </header>
      <main className="main">
        <div className="main__inner">
          <div className="intro">
            <span className="intro__emblem">
              <img src={emblem} alt="" width="14" height="18" />
            </span>
            <p className="eyebrow intro__eyebrow">SmartStation OS</p>
            <h1 className="intro__title">
              {register ? "Create an account" : "Welcome back"}
            </h1>
            <p className="intro__sub">
              {register
                ? "Order fuel and track your orders."
                : "Sign in to Ma7atati."}
            </p>
          </div>
          <div className="card">
            <form
              className="form"
              onSubmit={(event) => {
                event.preventDefault();
                const fields = Object.fromEntries(
                  new FormData(event.currentTarget),
                );
                action.run(() =>
                  authenticate(register ? "register" : "login", fields),
                );
              }}
            >
              {register && (
                <label className="field">
                  <span className="field__label">Full name</span>
                  <input
                    className="input"
                    name="name"
                    autoComplete="name"
                    required
                    maxLength={128}
                  />
                </label>
              )}
              <label className="field">
                <span className="field__label">Email address</span>
                <input
                  className="input"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  maxLength={254}
                />
              </label>
              <div className="field">
                <label className="field__label" htmlFor="password">
                  Password
                </label>
                <div className="field__control">
                  <input
                    id="password"
                    className="input input--has-action"
                    type={visible ? "text" : "password"}
                    name="password"
                    autoComplete={
                      register ? "new-password" : "current-password"
                    }
                    minLength={register ? 12 : undefined}
                    maxLength={72}
                    aria-describedby={register ? "password-help" : undefined}
                    required
                  />
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={visible ? "Hide password" : "Show password"}
                    aria-pressed={visible}
                    onClick={() => setVisible(!visible)}
                  >
                    <img src={eye} alt="" width="17" height="12" />
                  </button>
                </div>
                {register && (
                  <small id="password-help">
                    Use at least 12 characters with upper and lower case
                    letters, a number, and a symbol.
                  </small>
                )}
              </div>
              <Status action={action} />
              <button
                className="button"
                type="submit"
                disabled={action.pending}
              >
                {action.pending
                  ? "Please wait…"
                  : register
                    ? "Create account"
                    : "Sign in"}
                <img src={arrow} alt="" width="12" height="12" />
              </button>
            </form>
            <p className="account-link">
              {register ? "Already have an account?" : "New to SmartStation?"}{" "}
              <Link to={register ? "/" : "/register"}>
                {register ? "Sign in" : "Create a customer account"}
              </Link>
            </p>
          </div>
          <figure className="illustration">
            <Canopy />
          </figure>
        </div>
      </main>
      <footer className="footer">
        <div className="footer__inner">
          <span className="footer__text">SmartStation OS</span>
        </div>
      </footer>
    </div>
  );
}
