import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { DASHBOARD_CARD_IDS } from '../core/models/dashboard';
import { DataStore } from '../core/services/data-store.service';
import { ContextMenuService } from '../shared/context-menu/context-menu.service';
import { CardMenuDirective } from './card-menu.directive';
import { CARDS } from './card-registry';
import { CARD_TITLES } from './card-titles';

describe('registre des cadres', () => {
  it('a un composant et un titre pour chaque cadre, et rien d’autre', () => {
    expect(Object.keys(CARDS).sort()).toEqual([...DASHBOARD_CARD_IDS].sort());
    expect(Object.keys(CARD_TITLES).sort()).toEqual([...DASHBOARD_CARD_IDS].sort());
    for (const id of DASHBOARD_CARD_IDS) {
      expect(CARDS[id].component).toBeTruthy();
      expect(CARD_TITLES[id].length).toBeGreaterThan(0);
    }
  });
});

@Component({
  imports: [CardMenuDirective],
  template: `<div appCard="meters-recent-power"><input /></div>`,
})
class Host {}

describe('menu d’un cadre', () => {
  const rightClick = (target: Element): MouseEvent => {
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  };

  it('propose d’ajouter, puis de retirer le cadre', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const menus = TestBed.inject(ContextMenuService);
    const store = TestBed.inject(DataStore);
    const card = fixture.nativeElement.querySelector('[appCard]') as Element;

    expect(rightClick(card).defaultPrevented).toBe(true);
    expect(menus.menu()?.items.map((i) => i.label)).toEqual(['Ajouter au dashboard']);
    menus.menu()!.items[0]!.action();
    expect(store.dashboard().at(-1)).toBe('meters-recent-power');

    rightClick(card);
    expect(menus.menu()?.items.map((i) => i.label)).toEqual(['Retirer du dashboard']);
    menus.menu()!.items[0]!.action();
    expect(store.dashboard()).not.toContain('meters-recent-power');
  });

  it('laisse le menu habituel dans un champ de saisie', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const menus = TestBed.inject(ContextMenuService);
    menus.close();
    expect(rightClick(fixture.nativeElement.querySelector('input')).defaultPrevented).toBe(false);
    expect(menus.menu()).toBeNull();
  });
});
