import { Injectable, signal } from '@angular/core';
import type { IconName } from '../icon.component';

export interface MenuItem {
  readonly label: string;
  readonly icon?: IconName;
  readonly disabled?: boolean;
  readonly action: () => void;
}

export interface OpenMenu {
  readonly x: number;
  readonly y: number;
  readonly items: readonly MenuItem[];
}

/** Menu contextuel de l'application (un seul ouvert à la fois), affiché par `ContextMenuComponent`. */
@Injectable({ providedIn: 'root' })
export class ContextMenuService {
  readonly menu = signal<OpenMenu | null>(null);

  open(event: MouseEvent, items: readonly MenuItem[]): void {
    event.preventDefault();
    event.stopPropagation();
    this.menu.set({ x: event.clientX, y: event.clientY, items });
  }

  close(): void {
    this.menu.set(null);
  }
}
