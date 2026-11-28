// Money Bansho: the task picker. Russian texts, only the tasks that change
// something here, and a line saying what each one switches on.
import {
  applyMissionPresetToState,
  getMissionPresetsForVariant,
  resolveMissionPresetForVariant,
  type MissionMapView,
  type MissionPreset,
  type MissionTimeRange,
} from '@/services/mission-presets';
import { VARIANT_DEFAULTS } from '@/config/panels';
import { isBanshoPanelAvailable } from '@/config/bansho-panels';
import { SITE_VARIANT } from '@/config/variant';
import { uiRussian } from '@/utils/ui-russian';

const TEXT: Record<string, Pick<MissionPreset, 'label' | 'shortLabel' | 'description'>> = {
  'crisis-desk': { label: 'Кризисный штаб', shortLabel: 'Кризис', description: 'Конфликты и угрозы: хронология, Ближний Восток, Европа, Израиль, КНДР и предупреждения.' },
  'supply-chain-risk': { label: 'Риски поставок', shortLabel: 'Поставки', description: 'Сырьё, энергия и рынки, а также новости Китая, Азии и Европы.' },
  'energy-security': { label: 'Энергобезопасность', shortLabel: 'Энергия', description: 'Нефть и газ: новости энергетики, сырьё, Ближний Восток и Европа.' },
  'osint-newsroom': { label: 'Новостной поиск', shortLabel: 'Новости', description: 'Новости по всем регионам, прямые эфиры, веб-камеры и предупреждения.' },
  'macro-market-watch': { label: 'Рынки и акции', shortLabel: 'Рынки', description: 'Акции, сырьё и криптовалюты, смена руководства компаний и увольнения.' },
  'tech-ai-watch': { label: 'Технологии и ИИ', shortLabel: 'Технологии', description: 'Технологии и ИИ, увольнения, руководство компаний, рынки и ваши мониторы.' },
  'country-watcher': { label: 'Страны под наблюдением', shortLabel: 'Страны', description: 'Политика и власти, аналитические центры, Китай, Израиль, КНДР и здоровье.' },
};

const REGION: Record<MissionMapView, string> = {
  global: 'весь мир', america: 'Америка', mena: 'Ближний Восток', eu: 'Европа',
  asia: 'Азия', latam: 'Латинская Америка', africa: 'Африка', oceania: 'Океания',
};

const PERIOD: Record<MissionTimeRange, string> = {
  '1h': '1 час', '6h': '6 часов', '24h': '24 часа', '48h': '48 часов', '7d': '7 дней', all: 'всё время',
};

function count(value: number, one: string, few: string, many: string): string {
  const form = new Intl.PluralRules('ru').select(value);
  return `${value} ${form === 'one' ? one : form === 'few' ? few : many}`;
}

export function localizeMission<T extends MissionPreset | null>(preset: T): T {
  const text = preset && uiRussian() ? TEXT[preset.id] : undefined;
  return text ? ({ ...preset, ...text } as T) : preset;
}

/**
 * Nothing is sold here, so a task that needs a paid plan is left out. So is one
 * whose panels this dashboard does not have: applying it would switch on
 * everything, or leave the map alone on the screen.
 */
export function missionPickerPresets(variant: string = SITE_VARIANT): MissionPreset[] {
  const own = new Set(VARIANT_DEFAULTS[variant] ?? VARIANT_DEFAULTS.full);
  return getMissionPresetsForVariant(variant)
    .filter((preset) => !preset.requiresFocus
      && resolveMissionPresetForVariant(preset, variant).panels.filter((key) => key !== 'map' && own.has(key) && isBanshoPanelAvailable(key)).length >= 2)
    .map((preset) => localizeMission(preset));
}

/** What applying the task switches on, counted by the code that applies it. */
export function missionEffect(preset: MissionPreset, variant: string = SITE_VARIANT): string {
  const state = applyMissionPresetToState(preset.id, {}, undefined, variant);
  const panels = state.panelOrder.length + 1;
  const layers = Object.values(state.mapLayers).filter(Boolean).length;
  if (!uiRussian()) return `${panels} panels · ${layers} map layers`;
  return [
    count(panels, 'панель', 'панели', 'панелей'),
    count(layers, 'слой карты', 'слоя карты', 'слоёв карты'),
    REGION[preset.view],
    PERIOD[preset.timeRange],
  ].join(' · ');
}
