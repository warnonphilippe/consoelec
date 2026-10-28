import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterRenderEffect,
  inject,
  viewChild,
} from '@angular/core';
import { NavigationStart, Router } from '@angular/router';
import { IconComponent } from '../icon.component';
import { ContextMenuService, type MenuItem } from './context-menu.service';

/** Marge entre le menu et le bord de la fenêtre (px). */
const EDGE = 8;

/** Menu contextuel : ouvert au point du clic droit, gardé dans la fenêtre, fermé par un clic ailleurs ou Échap. */
@Component({
  selector: 'app-context-menu',
  imports: [IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:pointerdown)': 'onPointerDown($event)',
    '(document:keydown.escape)': 'menus.close()',
    '(window:blur)': 'menus.close()',
    '(window:resize)': 'menus.close()',
  },
  template: `
    @if (menus.menu(); as m) {
      <div
        #panel
        class="context-menu"
        role="menu"
        [style.left.px]="m.x"
        [style.top.px]="m.y"
        (keydown)="onKey($event)"
        (contextmenu)="$event.preventDefault()"
      >
        @for (item of m.items; track item.label) {
          <button type="button" role="menuitem" [disabled]="item.disabled" (click)="run(item)">
            @if (item.icon) {
              <app-icon [name]="item.icon" [size]="15" />
            }
            {{ item.label }}
          </button>
        }
      </div>
    }
  `,
  styles: `
    .context-menu {
      position: fixed;
      z-index: 1000;
      min-width: 210px;
      padding: 5px;
      background: var(--surface);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-sm);
      box-shadow: var(--shadow-pop);
    }
    button {
      display: flex;
      align-items: center;
      gap: 9px;
      width: 100%;
      padding: 7px 10px;
      border: 0;
      border-radius: 6px;
      background: none;
      color: var(--text);
      font: inherit;
      font-size: 13px;
      text-align: left;
      cursor: pointer;
    }
    button:hover:not(:disabled),
    button:focus-visible {
      background: var(--accent-soft);
      outline: none;
    }
    button:disabled {
      color: var(--text-faint);
      cursor: default;
    }
  `,
})
export class ContextMenuComponent {
  protected readonly menus = inject(ContextMenuService);
  private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');

  constructor() {
    // Gardé dans la fenêtre, puis le premier choix reçoit le focus (navigation au clavier).
    afterRenderEffect(() => {
      const menu = this.menus.menu();
      const el = this.panel()?.nativeElement;
      if (!menu || !el) {
        return;
      }
      const rect = el.getBoundingClientRect();
      el.style.left = `${Math.max(EDGE, Math.min(menu.x, window.innerWidth - rect.width - EDGE))}px`;
      el.style.top = `${Math.max(EDGE, Math.min(menu.y, window.innerHeight - rect.height - EDGE))}px`;
      el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    });
    const sub = inject(Router).events.subscribe((e) => {
      if (e instanceof NavigationStart) {
        this.menus.close();
      }
    });
    // Le défilement d'une zone intérieure ne remonte pas jusqu'au document : écouté en phase de capture.
    const onScroll = (): void => this.menus.close();
    document.addEventListener('scroll', onScroll, true);
    inject(DestroyRef).onDestroy(() => {
      sub.unsubscribe();
      document.removeEventListener('scroll', onScroll, true);
    });
  }

  protected onPointerDown(event: PointerEvent): void {
    if (!this.panel()?.nativeElement.contains(event.target as Node)) {
      this.menus.close();
    }
  }

  protected run(item: MenuItem): void {
    this.menus.close();
    item.action();
  }

  protected onKey(event: KeyboardEvent): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      return;
    }
    event.preventDefault();
    const buttons = [
      ...(this.panel()?.nativeElement.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
    ];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }
}
