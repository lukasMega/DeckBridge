import React, { type ReactNode } from 'react';
import OriginalNavbarLogo from '@theme-original/Navbar/Logo';
import { useLocation } from '@docusaurus/router';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';

// The blog list is the only route the theme renders without an h1 (posts, tag
// pages and the archive each bring their own). Supply one next to the brand, so
// it sits inside .navbar__inner, and only on that route — a second h1 elsewhere
// would be wrong for screen readers and for the one-h1-per-page build test.
// Wrapping Navbar/Content instead would land it outside .navbar__inner, which
// that component (not Navbar/Layout) renders.
const BLOG_LIST = /^\/blog(\/page\/\d+)?\/?$/;

export default function NavbarLogo(): ReactNode {
  const { pathname } = useLocation();
  const { siteConfig } = useDocusaurusContext();
  const base = siteConfig.baseUrl.replace(/\/$/, '');
  const route = pathname.startsWith(base) ? pathname.slice(base.length) : pathname;

  return (
    <>
      {BLOG_LIST.test(route) && <h1 className="sr-only">blog</h1>}
      <OriginalNavbarLogo />
    </>
  );
}
