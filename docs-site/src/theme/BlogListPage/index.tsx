import React, { type ReactNode } from 'react';
import OriginalBlogListPage from '@theme-original/BlogListPage';
import type { Props } from '@theme/BlogListPage';

export default function BlogListPage(props: Props): ReactNode {
  return (
    <>
      <h1 className="sr-only">{props.metadata.blogTitle}</h1>
      <OriginalBlogListPage {...props} />
    </>
  );
}
