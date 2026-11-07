import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';

/** Marge entre la bulle et le bord de la fenêtre ou le bouton (px). */
const GAP = 8;
const WIDTH = 340;

/**
 * Info-bulle des cadres : une seule à la fois, ouverte sous l'icône d'information du cadre. Elle se ferme par un
 * nouveau clic sur l'icône, un clic ailleurs, Échap, ou quand la page défile ou change de taille.
 */
@Injectable({ providedIn: 'root' })
export class CardInfoService {
  private readonly document = inject(DOCUMENT);
  private bubble: HTMLElement | null = null;
  private anchor: HTMLElement | null = null;
  private readonly onPointer = (event: Event): void => {
    const target = event.target as Node | null;
    if (target && (this.bubble?.contains(target) || this.anchor?.contains(target))) {
      return;
    }
    this.close();
  };
  private readonly onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      const anchor = this.anchor;
      this.close();
      anchor?.focus();
    }
  };
  private readonly onMove = (): void => this.close();

  /** Ouvre la bulle sous `anchor`, ou la ferme si elle y est déjà ouverte. */
  toggle(anchor: HTMLElement, title: string, text: string): void {
    if (this.anchor === anchor) {
      this.close();
      return;
    }
    this.close();
    const doc = this.document;
    const bubble = doc.createElement('div');
    bubble.className = 'card-info-bubble';
    bubble.id = 'card-info-bubble';
    bubble.setAttribute('role', 'dialog');
    bubble.setAttribute('aria-label', title);
    const heading = doc.createElement('strong');
    heading.textContent = title;
    const body = doc.createElement('p');
    body.textContent = text;
    bubble.append(heading, body);
    doc.body.append(bubble);

    const view = doc.defaultView;
    const vw = view?.innerWidth ?? 1024;
    const vh = view?.innerHeight ?? 768;
    const width = Math.min(WIDTH, vw - 2 * GAP);
    bubble.style.width = `${width}px`;
    const r = anchor.getBoundingClientRect();
    const left = Math.min(Math.max(GAP, r.left + r.width / 2 - width / 2), vw - width - GAP);
    const below = r.bottom + GAP;
    const height = bubble.offsetHeight;
    const top = below + height > vh - GAP && r.top - GAP - height > GAP ? r.top - GAP - height : below;
    bubble.style.left = `${left}px`;
    bubble.style.top = `${top}px`;

    anchor.setAttribute('aria-expanded', 'true');
    anchor.setAttribute('aria-controls', bubble.id);
    this.bubble = bubble;
    this.anchor = anchor;
    doc.addEventListener('pointerdown', this.onPointer, true);
    doc.addEventListener('keydown', this.onKey, true);
    doc.addEventListener('scroll', this.onMove, true);
    view?.addEventListener('resize', this.onMove);
  }

  close(): void {
    if (this.bubble === null) {
      return;
    }
    const doc = this.document;
    doc.removeEventListener('pointerdown', this.onPointer, true);
    doc.removeEventListener('keydown', this.onKey, true);
    doc.removeEventListener('scroll', this.onMove, true);
    doc.defaultView?.removeEventListener('resize', this.onMove);
    this.anchor?.setAttribute('aria-expanded', 'false');
    this.anchor?.removeAttribute('aria-controls');
    this.bubble.remove();
    this.bubble = null;
    this.anchor = null;
  }

  /** Ferme la bulle si elle appartient à `anchor` (cadre retiré de la page). */
  closeFor(anchor: HTMLElement): void {
    if (this.anchor === anchor) {
      this.close();
    }
  }
}
