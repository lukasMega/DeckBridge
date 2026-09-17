import React, { type ReactNode } from 'react';
import OriginalBlogLayout from '@theme-original/BlogLayout';
import type { Props } from '@theme/BlogLayout';
import { useLocation } from '@docusaurus/router';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';

const BLOG_LIST = /^\/blog(\/page\/\d+)?\/?$/;

export default function BlogLayout({ children, ...props }: Props): ReactNode {
  const { pathname } = useLocation();
  const { siteConfig } = useDocusaurusContext();
  const base = siteConfig.baseUrl.replace(/\/$/, '');
  const route = pathname.startsWith(base) ? pathname.slice(base.length) : pathname;

  return (
    <OriginalBlogLayout {...props}>
      {BLOG_LIST.test(route) && (
        <header className="db-blog-intro">
          <span className="db-blog-eyebrow">DECKBRIDGE JOURNAL</span>
          <h1>Blog</h1>
          <p>Release notes, supported hardware, and project updates.</p>
        </header>
      )}
      {children}
    </OriginalBlogLayout>
  );
}
