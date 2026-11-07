import type { CardId } from '../core/models/dashboard';

/**
 * Ce que montre chaque cadre, affiché par son icône d'information. Le texte décrit le contenu et sa source, sans
 * commenter les valeurs.
 */
export const CARD_DESCRIPTIONS: Record<CardId, string> = {
  'live-meter':
    "Ce que le compteur mesure en ce moment, lu chaque minute par le lecteur HomeWizard (port P1) : puissance soutirée au réseau ou injectée, moyenne du quart d'heure en cours (base du tarif capacitaire), tarif en cours (heures pleines ou creuses) et les quatre index.",
  'live-production':
    "Production des panneaux lue chaque minute sur l'onduleur : puissance du moment, énergie produite depuis le début de la journée et index total de production.",
  'billing-hp':
    "Solde des heures pleines de l'année de facturation : soutiré en heures pleines (1.8.1) moins injecté en heures pleines (2.8.1). Positif, c'est de l'énergie à payer ; négatif, un surplus non remboursé. Le cadre donne le solde à ce jour, puis le solde estimé en fin d'année et son coût.",
  'billing-hc':
    "Solde des heures creuses de l'année de facturation : soutiré en heures creuses (1.8.2) moins injecté en heures creuses (2.8.2). Positif, c'est de l'énergie à payer ; négatif, un surplus non remboursé. Le cadre donne le solde à ce jour, puis le solde estimé en fin d'année et son coût.",
  'billing-cost':
    "Coût estimé de l'énergie à payer sur l'année de facturation : soldes de fin d'année des heures pleines et creuses multipliés par le prix moyen du kWh de chaque période, avec le coût à ce jour et le surplus perdu en fin d'année.",
  'billing-schedule':
    'Horaire des heures pleines et des heures creuses (tel que réglé dans les réglages) et période tarifaire en cours.',
  'meters-total-import':
    "Index total de soutirage : somme des index heures pleines (1.8.1) et heures creuses (1.8.2), estimée aujourd'hui à partir des derniers relevés ou de la dernière lecture du compteur.",
  'meters-total-export':
    "Index total d'injection : somme des index heures pleines (2.8.1) et heures creuses (2.8.2), estimée aujourd'hui à partir des derniers relevés ou de la dernière lecture du compteur.",
  'meters-register-importPeak':
    "Sous-compteur du soutirage en heures pleines (1.8.1) : index estimé aujourd'hui, dernier relevé et énergie soutirée sur les 7 et 30 derniers jours.",
  'meters-register-importOff':
    "Sous-compteur du soutirage en heures creuses (1.8.2) : index estimé aujourd'hui, dernier relevé et énergie soutirée sur les 7 et 30 derniers jours.",
  'meters-register-exportPeak':
    "Sous-compteur de l'injection en heures pleines (2.8.1) : index estimé aujourd'hui, dernier relevé et énergie injectée sur les 7 et 30 derniers jours.",
  'meters-register-exportOff':
    "Sous-compteur de l'injection en heures creuses (2.8.2) : index estimé aujourd'hui, dernier relevé et énergie injectée sur les 7 et 30 derniers jours.",
  'meters-recent-power':
    'Soutirage et injection moyens des 5 dernières minutes, en watts, calculés à partir des index lus chaque minute par le lecteur P1 (heures pleines et creuses confondues).',
  'meters-today-energy':
    "Énergie soutirée et injectée depuis minuit (ou depuis la première lecture du jour si l'index de minuit est inconnu), heures pleines et creuses confondues, d'après les index du compteur.",
  'meters-index-chart':
    "Évolution des index cumulés des quatre sous-compteurs : relevés encodés et lectures du lecteur P1 (traits pleins), puis prévision (pointillés). Les boutons choisissent la période affichée, la durée de la prévision et les sous-compteurs montrés.",
  'meters-profile-day':
    "Soutirage (barres vers le haut) et injection (barres vers le bas) de chaque quart d'heure d'une journée, en puissance moyenne (kW), avec la courbe de production de l'onduleur. Les barres pâles sont estimées : l'énergie d'une période sans lecture (Mac éteint, app fermée) y est répartie uniformément. Les flèches et le calendrier changent de jour.",
  'meters-profile-days':
    "Énergie soutirée (vers le haut) et injectée (vers le bas) chaque jour, en kWh, sur 30 jours, 90 jours ou un an. Les jours pâles sont incomplets ou en partie estimés. Un clic sur un jour ouvre son détail au quart d'heure. Le bouton importe l'historique exporté depuis l'app HomeWizard Energy.",
  'meters-balance':
    "Soldes de facturation des heures pleines et des heures creuses (soutiré moins injecté) depuis le début de chaque année de facturation, mesurés puis prévus (pointillés), avec les courbes limites. Au-dessus de zéro, énergie à payer ; en dessous, surplus non remboursé. Les boutons choisissent la période affichée et la durée de la prévision.",
  'meters-balance-to-date':
    "Soldes des heures pleines et creuses mesurés depuis le début de l'année de facturation jusqu'au dernier relevé ou à la dernière lecture du compteur, avec l'énergie à payer et le surplus.",
  'meters-balance-current-year':
    "Soldes des heures pleines et creuses prévus à la fin de l'année de facturation en cours, avec l'énergie à payer et le surplus non remboursé.",
  'meters-balance-next-year':
    "Soldes des heures pleines et creuses prévus à la fin de l'année de facturation suivante, avec l'énergie à payer et le surplus non remboursé.",
  'meters-split-import':
    'Répartition du soutirage des 12 derniers mois entre heures pleines (1.8.1) et heures creuses (1.8.2).',
  'meters-split-export':
    "Répartition de l'injection des 12 derniers mois entre heures pleines (2.8.1) et heures creuses (2.8.2).",
  'production-day':
    "Courbe de puissance des panneaux sur une journée, lue dans le journal de l'onduleur (un point toutes les 5 minutes), avec l'énergie produite, l'attendu du modèle de référence et la puissance maximale. Les flèches et le calendrier changent de jour.",
  'production-7d':
    'Énergie produite par les panneaux sur les 7 derniers jours, moyenne par jour et écart avec la production attendue par le modèle de référence.',
  'production-30d':
    'Énergie produite par les panneaux sur les 30 derniers jours, comparée à la production attendue par le modèle de référence.',
  'production-year':
    "Énergie produite depuis le 1er janvier, comparée à l'attendu sur la même période et à la production d'une année complète selon le modèle de référence.",
  'production-best-day': 'Journée où les panneaux ont le plus produit, et son énergie.',
  'production-yield':
    "Rendement mesuré des panneaux : énergie produite par kWc installé, ramenée à une année, comparé au rendement indiqué dans les réglages.",
  'production-history':
    "Historique de la production des panneaux : par jour (30 jours), par mois (12 mois ou tous les mois) ou par année, comparé à la production attendue par le modèle de référence.",
  'stats-season-winter':
    "Soutirage et injection moyens d'un hiver (décembre à février), comparés à la référence d'un ménage belge choisie dans les réglages.",
  'stats-season-spring':
    "Soutirage et injection moyens d'un printemps (mars à mai), comparés à la référence d'un ménage belge choisie dans les réglages.",
  'stats-season-summer':
    "Soutirage et injection moyens d'un été (juin à août), comparés à la référence d'un ménage belge choisie dans les réglages.",
  'stats-season-autumn':
    "Soutirage et injection moyens d'un automne (septembre à novembre), comparés à la référence d'un ménage belge choisie dans les réglages.",
  'stats-years-chart':
    "Comparaison des années, mois par mois, pour l'indicateur choisi (soutirage, injection, solde net, production ou consommation de la maison), avec la référence belge.",
  'stats-monthly-table':
    "Valeurs mensuelles de l'indicateur choisi pour chaque année, avec la moyenne des années et la référence belge.",
  'stats-registers':
    "Totaux par année de chaque sous-compteur (soutirage et injection, heures pleines et creuses), avec le soutirage et l'injection totaux, le solde net, la part des heures creuses et, si la production est connue, l'autoconsommation et l'autarcie.",
  'forecast-controls':
    'Choix du profil de prévision utilisé par les cadres de la page Prévisions, et prise en compte ou non de la voiture électrique prévue.',
  'forecast-import': 'Énergie que le profil de prévision choisi prévoit de soutirer au réseau sur les 12 prochains mois.',
  'forecast-export': "Énergie que le profil de prévision choisi prévoit d'injecter sur le réseau sur les 12 prochains mois.",
  'forecast-net':
    'Solde net prévu sur les 12 prochains mois (soutirage moins injection) selon le profil de prévision choisi.',
  'forecast-ev':
    "Effet de la voiture électrique prévue sur une année : soutirage supplémentaire (dont la part en heures creuses) et, le cas échéant, injection en moins.",
  'forecast-monthly-chart':
    'Soutirage, injection et solde prévus mois par mois sur les 12 prochains mois, selon le profil de prévision choisi.',
  'forecast-index-chart':
    'Index des sous-compteurs : relevés des 6 derniers mois (traits pleins) et projection sur 18 mois (pointillés) selon le profil de prévision choisi.',
  'forecast-reliability':
    "Fiabilité de chaque profil de prévision sur les mois déjà mesurés : la prévision est refaite pour chaque mois passé avec les seuls relevés connus alors, puis comparée à ce qui a été mesuré.",
  'forecast-profiles':
    'Prévisions des différents profils sur les 12 prochains mois, côte à côte, avec les coefficients de recalage tirés des relevés.',
  'forecast-year-ends':
    "Index des sous-compteurs projetés au 31 décembre de l'année en cours et de la suivante, selon le profil de prévision choisi.",
};
