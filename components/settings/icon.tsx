import type { ComponentProps } from 'react';
import { Icon } from '@/components/ui/icons';

/** The prototype's icon (app.js `icon`): 18×18 with a 1.5 stroke; settings.css sizes it wherever the prototype's CSS does. */
export function I({ name }: { name: ComponentProps<typeof Icon>['name'] }) {
  return <Icon name={name} className="" width={18} height={18} strokeWidth={1.5} />;
}
