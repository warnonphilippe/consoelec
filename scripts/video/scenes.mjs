/**
 * Scénario de la vidéo : pour chaque scène, le texte dit par la voix off (`say`, écrit pour être bien prononcé),
 * le sous-titre affiché et les actions dans la page. `run` reçoit des aides (voir `record.mjs`) ; `at(s)` attend
 * que `s` secondes se soient écoulées depuis le début de la scène, pour caler les gestes sur la voix.
 * Jamais de passage par Réglages ni Maison.
 */

const DASH = '.dash-item';

export const scenes = [
  {
    id: 'intro',
    say: "Conso Élec suit la consommation et la production d'électricité d'une maison équipée de panneaux solaires. Voici un tour rapide de l'application.",
    caption:
      "<b>ConsoElec</b> suit la consommation et la production d'électricité d'une maison équipée de panneaux solaires.",
    async run({ video, at }) {
      await video('card', 'ConsoElec', 'Électricité et solaire, à la maison');
      await at(4.2);
      await video('card', null);
      await video('cursor', true);
    },
  },
  {
    id: 'wifi-meter',
    say: 'Aucun relevé à faire : le compteur intelligent est lu directement sur le Wi-Fi de la maison, par son port P un et un petit lecteur Home Wizard. Toutes les minutes, sans abonnement ni nuage.',
    caption:
      'Le compteur intelligent est lu <b>directement sur le Wi-Fi</b>, par son port P1 et un lecteur HomeWizard : toutes les minutes, sans cloud.',
    async run({ highlight, moveTo, at }) {
      await highlight(`${DASH}:has(app-live-meter)`);
      await moveTo(`${DASH}:has(app-live-meter) .live-value`);
      await at(6);
      await moveTo(`${DASH}:has(app-live-meter) .indexes`);
    },
  },
  {
    id: 'wifi-inverter',
    say: "L'onduleur S M A est lu de la même façon, en local : puissance instantanée, production du jour et index total.",
    caption:
      "L'onduleur SMA aussi, <b>en local sur le Wi-Fi</b> : puissance instantanée, production du jour et index total.",
    async run({ highlight, moveTo }) {
      await highlight(`${DASH}:has(app-live-production)`);
      await moveTo(`${DASH}:has(app-live-production) .live-value`);
    },
  },
  {
    id: 'dashboard',
    say: "Le tableau de bord résume l'année de facturation : soldes en heures pleines et en heures creuses, facture estimée, et horaire du bihoraire. Chaque cadre peut être ajouté, déplacé ou retiré.",
    caption:
      "Le <b>tableau de bord</b> : soldes heures pleines et creuses de l'année, facture estimée, horaire du bihoraire. Les cadres se personnalisent.",
    async run({ highlight, moveTo, scrollTo, at }) {
      await scrollTo(`${DASH}:has(app-billing-period-card)`);
      await highlight(`${DASH}:has(app-billing-period-card)`);
      await moveTo(`${DASH}:has(app-billing-period-card)`);
      await at(5);
      await highlight(`${DASH}:has(app-billing-cost-card)`);
      await moveTo(`${DASH}:has(app-billing-cost-card)`);
      await at(6.8);
      await highlight('.mini-balance');
      await moveTo('.mini-balance');
      await at(8.6);
      await scrollTo(`${DASH}:has(app-billing-schedule-card)`);
      await highlight(`${DASH}:has(app-billing-schedule-card)`);
    },
  },
  {
    id: 'card-info',
    say: "Chaque cadre a, à côté de son titre, une petite icône d'information : un clic ouvre une bulle qui explique ce que le cadre représente.",
    caption: "Chaque cadre a son icône <b>ⓘ</b> : un clic explique <b>ce qu'il représente</b>.",
    async run({ highlight, moveTo, scrollTo, click, at }) {
      const card = `${DASH}:has(app-billing-cost-card)`;
      await scrollTo(card);
      await highlight(card);
      await at(2.2);
      await click(`${card} .card-info-btn`);
      await highlight(`${card}, .card-info-bubble`);
      await moveTo('.card-info-bubble');
      await at(9);
      await click(`${card} .card-info-btn`);
    },
  },
  {
    id: 'production-live',
    say: "La page Production montre la puissance en direct et la courbe de la journée. Ici, une belle journée d'été : l'onduleur plafonne à cinq kilowatts.",
    caption:
      'Page <b>Production</b> : puissance en direct et courbe de la journée, ici écrêtée à 5 kW par l’onduleur.',
    async run({ go, highlight, hoverChart, at }) {
      await go('Production');
      await highlight('app-live-production');
      await at(3.5);
      await highlight('app-production-day-card');
      await hoverChart('app-production-day-card', 0.15, 0.75);
    },
  },
  {
    id: 'production-history',
    say: "En dessous, la production du jour, du mois et de l'année, comparée à ce que l'installation devrait produire, puis tout l'historique importé du journal de l'onduleur.",
    caption:
      "Production du jour, du mois et de l'année <b>comparée à l'attendu</b>, et tout l'historique du journal de l'onduleur.",
    async run({ highlight, scrollTo, clickText, hoverChart, at }) {
      await scrollTo('.kpis');
      await highlight('.kpis');
      await at(4.5);
      await scrollTo('app-production-history-card');
      await highlight('app-production-history-card');
      await hoverChart('app-production-history-card', 0.5, 0.95);
      await clickText('app-production-history-card button', '12 mois');
      await hoverChart('app-production-history-card', 0.3, 0.9);
    },
  },
  {
    id: 'meters',
    say: "Côté consommation, la page Compteurs détaille le soutirage et l'injection, puis les quatre sous-compteurs du compteur intelligent : heures pleines et heures creuses, dans les deux sens.",
    caption:
      'Page <b>Compteurs</b> : soutirage et injection, et les quatre sous-compteurs (heures pleines / creuses).',
    async run({ go, highlight, moveTo, at }) {
      await go('Compteurs');
      await highlight('.totals');
      await moveTo('.totals');
      await at(5);
      await highlight('.cards4');
      await moveTo('.cards4');
    },
  },
  {
    id: 'meters-live',
    say: "La moyenne des cinq dernières minutes montre ce que la maison soutire ou injecte en ce moment, et les totaux du jour comptent depuis minuit.",
    caption: 'Moyennes des <b>5 dernières minutes</b> et <b>totaux du jour</b>, depuis minuit.',
    async run({ highlight, scrollTo, moveTo, at }) {
      await scrollTo('app-meter-recent-power-card');
      await highlight('app-meter-recent-power-card, app-meter-today-energy-card');
      await moveTo('app-meter-recent-power-card');
      await at(5);
      await moveTo('app-meter-today-energy-card');
    },
  },
  {
    id: 'meters-day',
    say: "En dessous, le soutirage et l'injection de la journée, quart d'heure par quart d'heure : le soutirage vers le haut, l'injection vers le bas, avec la production de l'onduleur par-dessus.",
    caption:
      '<b>Soutirage et injection</b> de la journée, au quart d’heure, avec la production de l’onduleur.',
    async run({ highlight, scrollTo, hoverChart, at }) {
      await scrollTo('app-meter-profile-day-card');
      await highlight('app-meter-profile-day-card');
      await at(3.5);
      await hoverChart('app-meter-profile-day-card', 0.1, 0.9);
    },
  },
  {
    id: 'meters-days',
    say: "Et jour par jour, sur trente jours, trois mois ou un an : un clic ouvre le détail d'une journée. Le lecteur P un ne garde pas d'historique : Conso Élec garde le sien, et l'historique de l'application Home Wizard s'importe en un clic.",
    caption:
      'Jour par jour, sur 30 jours, 3 mois ou un an. L’<b>historique HomeWizard</b> s’importe en un clic.',
    async run({ highlight, scrollTo, hoverChart, clickBar, at }) {
      await scrollTo('app-meter-profile-days-card');
      await highlight('app-meter-profile-days-card');
      await hoverChart('app-meter-profile-days-card', 0.15, 0.55);
      await at(5.5);
      await clickBar('app-meter-profile-days-card', 0.55, 'app-meter-profile-day-card h2');
      await scrollTo('app-meter-profile-day-card');
      await highlight('app-meter-profile-day-card');
      await at(10);
      await scrollTo('app-meter-profile-days-card');
      await highlight('app-meter-profile-days-card button.btn', 10);
    },
  },
  {
    id: 'meters-index',
    say: "Plus bas, l'évolution des index, jusqu'à la minute.",
    caption: 'Évolution des <b>index</b>, à la minute près.',
    async run({ highlight, scrollTo, hoverChart }) {
      await scrollTo('app-meter-index-chart-card');
      await highlight('app-meter-index-chart-card');
      await hoverChart('app-meter-index-chart-card', 0.2, 0.9);
    },
  },
  {
    id: 'meters-balance',
    say: "Les soldes, par période tarifaire, permettent d'anticiper la facture de régularisation, sur un mois, trois mois, ou toute l'année.",
    caption:
      'Les <b>soldes</b> par période tarifaire anticipent la facture de régularisation : vue sur 1 mois, 3 mois ou toute l’année.',
    async run({ highlight, scrollTo, clickText, at }) {
      await scrollTo('app-balance-card');
      await highlight('app-balance-card');
      await at(2.5);
      await clickText('app-balance-card button', '3 mois');
      await clickText('app-balance-card button', '+ 3 mois');
      await at(5);
      await clickText('app-balance-card button', '1 mois');
      await clickText('app-balance-card button', '+ 1 mois');
      await at(7.5);
      await clickText('app-balance-card button', '1 an');
      await clickText('app-balance-card button', '+ 12 mois');
      await highlight('app-balance-card, .balances');
    },
  },
  {
    id: 'manual',
    say: "Pas de lecteur P un ? On peut aussi encoder les quatre index à la main, à n'importe quelle date, même dans le passé. Claude peut aussi les lire sur une photo du compteur.",
    caption:
      'Sans lecteur P1, on <b>encode les quatre index à la main</b>, à n’importe quelle date, ou on les fait lire sur une photo.',
    async run({ go, highlight, typeInto, at }) {
      await go('Relevés');
      await highlight('form.entry');
      await at(3);
      await typeInto('#importPeak', '22115.4');
      await typeInto('#importOff', '12951.8');
      await typeInto('#exportPeak', '11642.2');
      await typeInto('#exportOff', '9467.9');
    },
  },
  {
    id: 'manual-list',
    say: 'Tous les relevés sont gardés, avec la consommation calculée entre deux relevés.',
    caption: 'Les relevés encodés sont listés, avec la consommation entre deux relevés.',
    async run({ highlight, scrollTo, moveTo }) {
      await scrollTo('.card.list');
      await highlight('.card.list');
      await moveTo('.card.list');
    },
  },
  {
    id: 'stats',
    say: 'Les statistiques reconstituent la consommation et la production par saison et par mois, et les comparent à une maison belge type.',
    caption: '<b>Statistiques</b> par saison et par mois, comparées à une maison belge type.',
    async run({ go, highlight, scrollTo, hoverChart, at }) {
      await go('Statistiques');
      await highlight('.seasons');
      await at(4);
      await scrollTo('app-stats-years-chart-card');
      await highlight('app-stats-years-chart-card');
      await hoverChart('app-stats-years-chart-card', 0.2, 0.85);
    },
  },
  {
    id: 'outro',
    say: "Conso Élec propose aussi des prévisions pour l'année à venir, avec ou sans voiture électrique, et un assistant I A pour interroger vos données. Et tout reste sur votre ordinateur.",
    caption:
      'Et aussi : <b>prévisions</b> (avec ou sans voiture électrique) et <b>assistant IA</b>. Vos données restent sur votre ordinateur.',
    async run({ go, highlight, moveTo, video, at }) {
      await moveTo('a.nav-item[href="/previsions"]');
      await highlight('a.nav-item[href="/previsions"], .assistant-btn', 4);
      await at(5.5);
      await go('Tableau de bord');
      await highlight(null);
      await at(8);
      await video('caption', null);
      await video('cursor', false);
      await video('card', 'ConsoElec', 'Consommation · Production · Wi-Fi local');
    },
    tail: 3,
  },
];
