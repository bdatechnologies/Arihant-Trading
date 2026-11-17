'use client';

import React from 'react';
import { useAuth } from '@/lib/auth-context';
import { ReportsNav } from './_lib/report-ui';

/**
 * The report tabs live here, not in each report page, so they stay mounted (and keep their scroll) while you switch
 * reports — only the report below them changes. The app layout keeps one <main> for every /reports page.
 */
export default function ReportsLayout({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  return (
    <>
      {user && <ReportsNav role={user.role} />}
      {children}
    </>
  );
}
