import { redirect } from 'next/navigation';

/** `/workspace` alone is the dashboard (prototype: "#/workspace … 进入 #/dashboard"); its sub-pages are the detail lists. */
export default function WorkspaceIndex() {
  redirect('/dashboard');
}
