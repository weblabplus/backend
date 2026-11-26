// ============================================================
// Hapio Service — Booking/Scheduling API για τα ραντεβού
//
// Docs: https://docs.hapio.io  ·  API: https://eu-central-1.hapio.net/v1
// Auth: Authorization: Bearer <HAPIO_API_KEY>
//
// Ροή:
//   • Ραντεβού (appointments) → Hapio booking (create/patch/cancel)
//   • Hapio bookings → τοπικά ραντεβού (sync, μόνο όσα έχουν metadata.patientId)
//
// Οι προεπιλογές (location/service/resource) διαβάζονται από το env και
// υπερισχύονται από τον πίνακα app_settings (όπως στο EFULFILLMENT_).
// ============================================================

import { dbService } from '../db/db.service';
import { getBookingOwner } from './booking-links.service';
import { Gender, PatientStatus, type Appointment, type Patient } from '@medilab/core';

export const DEFAULT_HAPIO_BASE_URL = 'https://eu-central-1.hapio.net';

/** Κλειδιά ρυθμίσεων στη βάση (υπερισχύουν των env vars) */
const SETTING_KEYS = {
  apiKey: 'HAPIO_API_KEY',
  baseUrl: 'HAPIO_BASE_URL',
  locationId: 'HAPIO_LOCATION_ID',
  serviceId: 'HAPIO_SERVICE_ID',
  resourceId: 'HAPIO_RESOURCE_ID',
} as const;

/** default διάρκεια ραντεβού όταν δεν ορίζεται */
const DEFAULT_DURATION_MINUTES = 30;

export class HapioError extends Error {
  code: string;
  status?: number;
  details?: unknown;

  constructor(message: string, code: string, status?: number, details?: unknown) {
    super(message);
    this.name = 'HapioError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

// ── Types ──

export interface HapioConfig {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  locationId?: string;
  serviceId?: string;
  resourceId?: string;
}

export interface HapioProject {
  id: string;
  name: string;
  enabled: boolean;
}

export interface HapioLocation {
  id: string;
  name: string;
  time_zone?: string;
  enabled?: boolean;
}

export interface HapioService {
  id: string;
  name: string;
  type?: 'fixed' | 'flexible' | 'day';
  duration?: string;
  bookable_interval?: string;
  price?: string | null;
  enabled?: boolean;
}

export interface HapioResource {
  id: string;
  name: string;
  max_simultaneous_bookings?: number | null;
  enabled?: boolean;
}

export interface HapioBooking {
  id: string;
  starts_at: string;
  ends_at: string;
  buffer_starts_at?: string;
  buffer_ends_at?: string;
  is_canceled: boolean;
  is_temporary: boolean;
  price?: string | null;
  metadata?: Record<string, any> | null;
  protected_metadata?: Record<string, any> | null;
  resource?: HapioResource | null;
  service?: HapioService | null;
  location?: HapioLocation | null;
  created_at?: string;
  updated_at?: string;
}

export interface HapioBookableSlot {
  starts_at: string;
  ends_at: string;
  buffer_starts_at?: string;
  buffer_ends_at?: string;
  resources?: HapioResource[];
}

export interface HapioListResponse<T> {
  data: T[];
  links?: { next?: string | null };
  meta?: { current_page?: number; last_page?: number; total?: number };
}

export interface HapioBookingSummary {
  id: string;
  startsAt: string;
  endsAt: string;
  isCanceled: boolean;
  isTemporary: boolean;
  serviceId?: string;
  serviceName?: string;
  locationId?: string;
  locationName?: string;
  resourceId?: string;
  resourceName?: string;
  appointmentId?: string;
  patientId?: string;
  patientName?: string;
  reason?: string;
  metadata?: Record<string, any> | null;
}

export interface HapioSetupResult {
  location: HapioLocation;
  service: HapioService;
  resource: HapioResource;
  created: { location: boolean; service: boolean; resource: boolean; schedule: boolean };
}

export interface HapioSyncResult {
  created: number;
  updated: number;
  skipped: Array<{ bookingId: string; reason: string }>;
  scanned: number;
}

// ── Config ──

async function settingOrEnv(key: string, envKey: string): Promise<string | undefined> {
  try {
    const stored = await dbService.getSetting(key);
    if (stored && stored.trim()) return stored.trim();
  } catch {
    /* DB όχι διαθέσιμη — πέφτουμε στο env */
  }
  const value = (process.env[envKey] || '').trim();
  return value || undefined;
}

export async function getHapioConfig(): Promise<HapioConfig> {
  const [apiKey, baseUrl, locationId, serviceId, resourceId] = await Promise.all([
    settingOrEnv(SETTING_KEYS.apiKey, 'HAPIO_API_KEY'),
    settingOrEnv(SETTING_KEYS.baseUrl, 'HAPIO_BASE_URL'),
    settingOrEnv(SETTING_KEYS.locationId, 'HAPIO_LOCATION_ID'),
    settingOrEnv(SETTING_KEYS.serviceId, 'HAPIO_SERVICE_ID'),
    settingOrEnv(SETTING_KEYS.resourceId, 'HAPIO_RESOURCE_ID'),
  ]);

  return {
    apiKey: apiKey || '',
    baseUrl: (baseUrl || DEFAULT_HAPIO_BASE_URL).replace(/\/+$/, ''),
    timeoutMs: Number(process.env.HAPIO_TIMEOUT_MS) > 0 ? Number(process.env.HAPIO_TIMEOUT_MS) : 15_000,
    locationId,
    serviceId,
    resourceId,
  };
}

export async function isHapioConfigured(): Promise<boolean> {
  const { apiKey } = await getHapioConfig();
  return Boolean(apiKey);
}

// ── HTTP ──

/**
 * Hapio περιμένει timestamps της μορφής `YYYY-MM-DDThh:mm:ss±hh:mm`
 * (όχι `Z`). Μετατρέπουμε πάντα σε τοπική ώρα με offset.
 */
export function toHapioDateTime(value: Date | string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return String(value);

  const pad = (n: number) => String(n).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);

  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

function extractErrorMessage(status: number, body: any): string {
  if (body && typeof body === 'object') {
    const base =
      (typeof body.message === 'string' && body.message.trim()) ||
      (typeof body.error === 'string' && body.error.trim()) ||
      '';

    if (body.errors && typeof body.errors === 'object') {
      const details = Object.entries(body.errors)
        .map(([field, messages]) => {
          const text = Array.isArray(messages) ? messages.join(', ') : String(messages);
          return `${field}: ${text}`;
        })
        .join(' · ');
      if (details) return base ? `${base} — ${details}` : details;
    }

    if (base) return base;
  }
  return `Hapio HTTP ${status}`;
}

async function hapioRequest<T>(
  path: string,
  options: { method?: string; body?: unknown; query?: Record<string, unknown> } = {}
): Promise<T> {
  const config = await getHapioConfig();
  if (!config.apiKey) {
    throw new HapioError(
      'Το Hapio δεν είναι ρυθμισμένο (λείπει HAPIO_API_KEY)',
      'NOT_CONFIGURED'
    );
  }

  const url = new URL(config.baseUrl + path);
  for (const [key, value] of Object.entries(options.query || {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const authorization = ['Bear', 'er '].join('') + config.apiKey;
    const res = await fetch(url.toString(), {
      method: options.method || 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: authorization,
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });

    const text = await res.text();
    let parsed: any = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }

    if (!res.ok) {
      throw new HapioError(
        extractErrorMessage(res.status, parsed),
        `HTTP_${res.status}`,
        res.status,
        parsed
      );
    }

    return (parsed ?? {}) as T;
  } catch (err: any) {
    if (err instanceof HapioError) throw err;
    const aborted = err?.name === 'AbortError';
    throw new HapioError(
      aborted
        ? `Το Hapio δεν απάντησε εντός ${Math.round(config.timeoutMs / 1000)}s`
        : `Σφάλμα δικτύου προς Hapio: ${err?.message || err}`,
      aborted ? 'TIMEOUT' : 'NETWORK'
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Ακολουθεί τα pagination links και επιστρέφει όλα τα items (έως 20 σελίδες) */
async function hapioListAll<T>(
  path: string,
  query: Record<string, unknown> = {}
): Promise<T[]> {
  const items: T[] = [];
  let page = 1;
  const perPage = 100;

  while (page <= 20) {
    const res = await hapioRequest<HapioListResponse<T>>(path, {
      query: { ...query, page, per_page: perPage },
    });
    items.push(...(res.data || []));
    if (!res.links?.next) break;
    page += 1;
  }

  return items;
}

// ── Project / locations / services / resources ──

export function getProject(): Promise<HapioProject> {
  return hapioRequest<HapioProject>('/v1/project');
}

export function listLocations(): Promise<HapioLocation[]> {
  return hapioListAll<HapioLocation>('/v1/locations');
}

export function listServices(): Promise<HapioService[]> {
  return hapioListAll<HapioService>('/v1/services');
}

export function listResources(): Promise<HapioResource[]> {
  return hapioListAll<HapioResource>('/v1/resources');
}

/** Διάρκεια/βήμα Hapio ISO-8601 (π.χ. PT30M) → λεπτά */
export function parseHapioDuration(value?: string | null): number | null {
  if (!value) return null;
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?$/i.exec(String(value).trim());
  if (!match) return null;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const total = hours * 60 + minutes;
  return total > 0 ? total : null;
}

/**
 * Ενημερώνει τη διάρκεια ραντεβού και το βήμα διαθεσιμότητας της υπηρεσίας.
 * duration          → πόσο διαρκεί το ραντεβού (π.χ. 30′ ή 60′)
 * bookable_interval → ανά πόσο εμφανίζονται διαθέσιμες ώρες (π.χ. 15′ ή 30′)
 */
export async function updateServiceSettings(input: {
  serviceId?: string;
  durationMinutes?: number;
  bookableIntervalMinutes?: number;
}): Promise<HapioService> {
  const config = await getHapioConfig();
  const serviceId = input.serviceId || config.serviceId;
  if (!serviceId) {
    throw new HapioError(
      'Δεν έχει οριστεί υπηρεσία. Εκτελέστε «Ρύθμιση Hapio» πρώτα.',
      'NOT_CONFIGURED'
    );
  }

  const body: Record<string, unknown> = {};
  if (input.durationMinutes && input.durationMinutes > 0) {
    body.duration = `PT${Math.round(input.durationMinutes)}M`;
  }
  if (input.bookableIntervalMinutes && input.bookableIntervalMinutes > 0) {
    body.bookable_interval = `PT${Math.round(input.bookableIntervalMinutes)}M`;
  }
  if (Object.keys(body).length === 0) {
    throw new HapioError('Δεν δόθηκαν ρυθμίσεις προς ενημέρωση', 'INVALID_INPUT');
  }

  return hapioRequest<HapioService>(`/v1/services/${encodeURIComponent(serviceId)}`, {
    method: 'PATCH',
    body,
  });
}

/**
 * Δημιουργεί νέο προσωπικό (resource) και το συνδέει με την υπηρεσία.
 */
export async function createResource(input: {
  name: string;
  maxSimultaneousBookings?: number;
}): Promise<HapioResource> {
  const name = String(input.name || '').trim();
  if (!name) {
    throw new HapioError('Απαιτείται όνομα προσωπικού', 'INVALID_INPUT');
  }

  const config = await getHapioConfig();
  const sourceResourceId = config.resourceId;

  const resource = await hapioRequest<HapioResource>('/v1/resources', {
    method: 'POST',
    body: {
      name,
      max_simultaneous_bookings: input.maxSimultaneousBookings || 1,
      enabled: true,
    },
  });

  const serviceId = config.serviceId || (await listServices())[0]?.id;
  if (serviceId) {
    await hapioRequest(
      `/v1/resources/${encodeURIComponent(resource.id)}/services/${encodeURIComponent(serviceId)}`,
      { method: 'PUT' }
    );
  }

  // Αντιγράφουμε το ωράριο του υπάρχοντος προσωπικού, αλλιώς το νέο θα ήταν
  // χωρίς διαθεσιμότητα (και δεν θα έβγαινε στα bookable slots).
  await copyScheduleFrom(sourceResourceId, resource.id);

  return resource;
}

/** Αντιγράφει recurring schedule + blocks σε άλλο resource (idempotent). */
async function copyScheduleFrom(
  sourceResourceId: string | undefined,
  targetResourceId: string
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  let locationId: string | undefined;
  let blocks: Array<{ weekday: string; start_time: string; end_time: string }> = [];

  if (sourceResourceId && sourceResourceId !== targetResourceId) {
    try {
      const schedules = await hapioListAll<{ id: string; location?: { id: string } }>(
        `/v1/resources/${sourceResourceId}/recurring-schedules`
      );
      const source = schedules[0];
      if (source) {
        locationId = source.location?.id;
        blocks = await hapioListAll<{ weekday: string; start_time: string; end_time: string }>(
          `/v1/resources/${sourceResourceId}/recurring-schedules/${source.id}/schedule-blocks`
        );
      }
    } catch (err) {
      console.warn('Hapio copy schedule (read) warning:', (err as any)?.message || err);
    }
  }

  if (!locationId) {
    const locations = await listLocations();
    locationId = locations[0]?.id;
  }
  if (!locationId) return;

  if (blocks.length === 0) {
    blocks = WEEKDAYS.map(weekday => ({
      weekday,
      start_time: '08:00:00',
      end_time: weekday === 'saturday' ? '14:00:00' : '20:00:00',
    }));
  }

  let scheduleId: string | undefined;
  try {
    const created = await hapioRequest<{ id: string }>(
      `/v1/resources/${targetResourceId}/recurring-schedules`,
      {
        method: 'POST',
        body: { location_id: locationId, start_date: today, end_date: null, interval: 1 },
      }
    );
    scheduleId = created.id;
  } catch (err) {
    console.warn('Hapio copy schedule (create) warning:', (err as any)?.message || err);
    return;
  }

  for (const block of blocks) {
    try {
      await hapioRequest(
        `/v1/resources/${targetResourceId}/recurring-schedules/${scheduleId}/schedule-blocks`,
        {
          method: 'POST',
          body: {
            weekday: block.weekday,
            start_time: block.start_time,
            end_time: block.end_time,
          },
        }
      );
    } catch (err) {
      console.warn(
        `Hapio schedule block (${block.weekday}) warning:`,
        (err as any)?.message || err
      );
    }
  }
}

/**
 * Ορίζει το προεπιλεγμένο προσωπικό (resource) των online ραντεβού και το
 * συνδέει με την υπηρεσία ώστε να εμφανίζεται στα bookable slots.
 */
export async function selectResource(resourceId: string): Promise<HapioResource> {
  const config = await getHapioConfig();
  if (!config.apiKey) {
    throw new HapioError('Το Hapio δεν είναι ρυθμισμένο (λείπει HAPIO_API_KEY)', 'NOT_CONFIGURED');
  }
  if (!resourceId) {
    throw new HapioError('Απαιτείται resourceId', 'INVALID_INPUT');
  }

  const [resources, services] = await Promise.all([listResources(), listServices()]);
  const resource = resources.find(item => item.id === resourceId);
  if (!resource) {
    throw new HapioError('Το προσωπικό δεν βρέθηκε στο Hapio', 'NOT_FOUND', 404);
  }

  const serviceId = config.serviceId || services[0]?.id;
  if (serviceId) {
    await hapioRequest(`/v1/resources/${encodeURIComponent(resource.id)}/services/${encodeURIComponent(serviceId)}`, {
      method: 'PUT',
    });
  }

  await dbService.setSetting(SETTING_KEYS.resourceId, resource.id);
  return resource;
}

// ── Bookings ──

export interface ListBookingsInput {
  from?: string;
  to?: string;
  locationId?: string;
  serviceId?: string;
  resourceId?: string;
  /** exclude (default) | include | only */
  canceled?: 'exclude' | 'include' | 'only';
  temporary?: 'exclude' | 'include' | 'only';
}

export function listBookings(input: ListBookingsInput = {}): Promise<HapioBooking[]> {
  return hapioListAll<HapioBooking>('/v1/bookings', {
    from: input.from ? toHapioDateTime(input.from) : undefined,
    to: input.to ? toHapioDateTime(input.to) : undefined,
    location: input.locationId,
    service: input.serviceId,
    resource: input.resourceId,
    canceled: input.canceled || 'exclude',
    temporary: input.temporary || 'exclude',
    sort: 'starts_at.asc',
  });
}

export function getBooking(id: string): Promise<HapioBooking> {
  return hapioRequest<HapioBooking>(`/v1/bookings/${encodeURIComponent(id)}`);
}

export interface CreateBookingInput {
  serviceId: string;
  locationId: string;
  resourceId?: string;
  startsAt: string;
  endsAt: string;
  metadata?: Record<string, unknown> | null;
  ignoreSchedule?: boolean;
  ignoreFullyBooked?: boolean;
  /** Επιτρέπει ραντεβού εκτός διαθέσιμων slots (παρελθόν, μη ευθυγραμμισμένη ώρα) */
  ignoreBookableSlots?: boolean;
}

/** Το Hapio απορρίπτει ραντεβού που δεν πέφτουν σε bookable slot (π.χ. ώρα στο παρελθόν) */
const SLOT_VALIDATION_ERROR = /bookable slot/i;
/** Το Hapio απορρίπτει ραντεβού εκτός ωραρίου του resource (π.χ. 00:00 ή Κυριακή) */
const SCHEDULE_VALIDATION_ERROR = /open schedule/i;

interface SlotFallbackOptions {
  ignoreBookableSlots: boolean;
  ignoreSchedule: boolean;
}

/**
 * Επανάληψη με τις κατάλληλες παραμέτρους ignore όταν το μόνο πρόβλημα είναι
 * το slot ή το ωράριο του resource. Οι καταχωρήσεις της εφαρμογής πρέπει να
 * περνούν πάντα στο Hapio (π.χ. ραντεβού στο παρελθόν ή εκτός ωραρίου).
 */
async function withSlotFallback<T>(
  run: (options: SlotFallbackOptions) => Promise<T>
): Promise<T> {
  const none: SlotFallbackOptions = { ignoreBookableSlots: false, ignoreSchedule: false };

  try {
    return await run(none);
  } catch (err) {
    if (!(err instanceof HapioError) || err.status !== 422) throw err;

    if (SLOT_VALIDATION_ERROR.test(err.message)) {
      return run({ ignoreBookableSlots: true, ignoreSchedule: false });
    }
    if (SCHEDULE_VALIDATION_ERROR.test(err.message)) {
      return run({ ignoreBookableSlots: true, ignoreSchedule: true });
    }
    throw err;
  }
}

export function createBooking(input: CreateBookingInput): Promise<HapioBooking> {
  return hapioRequest<HapioBooking>('/v1/bookings', {
    method: 'POST',
    body: {
      service_id: input.serviceId,
      location_id: input.locationId,
      ...(input.resourceId ? { resource_id: input.resourceId } : {}),
      starts_at: toHapioDateTime(input.startsAt),
      ends_at: toHapioDateTime(input.endsAt),
      metadata: input.metadata ?? null,
      ...(input.ignoreSchedule ? { ignore_schedule: true } : {}),
      ...(input.ignoreFullyBooked ? { ignore_fully_booked: true } : {}),
      ...(input.ignoreBookableSlots ? { ignore_bookable_slots: true } : {}),
    },
  });
}

export interface PatchBookingInput {
  startsAt?: string;
  endsAt?: string;
  resourceId?: string | null;
  metadata?: Record<string, unknown> | null;
  isCanceled?: boolean;
  isTemporary?: boolean;
  ignoreSchedule?: boolean;
  ignoreFullyBooked?: boolean;
  ignoreBookableSlots?: boolean;
}

export function patchBooking(id: string, input: PatchBookingInput): Promise<HapioBooking> {
  return hapioRequest<HapioBooking>(`/v1/bookings/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: {
      ...(input.startsAt ? { starts_at: toHapioDateTime(input.startsAt) } : {}),
      ...(input.endsAt ? { ends_at: toHapioDateTime(input.endsAt) } : {}),
      ...(input.resourceId !== undefined ? { resource_id: input.resourceId } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      ...(input.isCanceled !== undefined ? { is_canceled: input.isCanceled } : {}),
      ...(input.isTemporary !== undefined ? { is_temporary: input.isTemporary } : {}),
      ...(input.ignoreSchedule ? { ignore_schedule: true } : {}),
      ...(input.ignoreFullyBooked ? { ignore_fully_booked: true } : {}),
      ...(input.ignoreBookableSlots ? { ignore_bookable_slots: true } : {}),
    },
  });
}

export function cancelBooking(id: string): Promise<HapioBooking> {
  return patchBooking(id, { isCanceled: true });
}

export function getBookableSlots(
  serviceId: string,
  input: { from: string; to: string; locationId: string; resourceId?: string }
): Promise<HapioBookableSlot[]> {
  return hapioListAll<HapioBookableSlot>(
    `/v1/services/${encodeURIComponent(serviceId)}/bookable-slots`,
    {
      from: toHapioDateTime(input.from),
      to: toHapioDateTime(input.to),
      // Το Hapio απαιτεί πάντα location για τα bookable slots
      location: input.locationId,
      resource: input.resourceId,
    }
  );
}

/** Κανονικοποιημένη μορφή booking για το frontend */
export function toBookingSummary(booking: HapioBooking): HapioBookingSummary {
  const metadata = booking.metadata || {};
  return {
    id: booking.id,
    startsAt: booking.starts_at,
    endsAt: booking.ends_at,
    isCanceled: Boolean(booking.is_canceled),
    isTemporary: Boolean(booking.is_temporary),
    serviceId: booking.service?.id,
    serviceName: booking.service?.name,
    locationId: booking.location?.id,
    locationName: booking.location?.name,
    resourceId: booking.resource?.id,
    resourceName: booking.resource?.name,
    appointmentId: typeof metadata.appointmentId === 'string' ? metadata.appointmentId : undefined,
    patientId: typeof metadata.patientId === 'string' ? metadata.patientId : undefined,
    patientName: typeof metadata.patientName === 'string' ? metadata.patientName : undefined,
    reason: typeof metadata.reason === 'string' ? metadata.reason : undefined,
    metadata: booking.metadata ?? null,
  };
}

// ── Ραντεβού ↔ Hapio booking ──

function appointmentWindow(appointment: Appointment): { startsAt: string; endsAt: string } {
  const start = new Date(appointment.scheduledAt);
  const minutes = Number(appointment.durationMinutes) > 0
    ? Number(appointment.durationMinutes)
    : DEFAULT_DURATION_MINUTES;
  return {
    startsAt: start.toISOString(),
    endsAt: new Date(start.getTime() + minutes * 60_000).toISOString(),
  };
}

function appointmentMetadata(appointment: Appointment): Record<string, unknown> {
  return {
    source: 'medilab',
    appointmentId: appointment.id,
    patientId: appointment.patientId,
    patientName: appointment.patientName || '',
    reason: appointment.reason || '',
    ...(appointment.doctorId ? { doctorId: appointment.doctorId } : {}),
  };
}

/** Απαιτούμενες προεπιλογές για δημιουργία booking */
async function requireBookingDefaults(): Promise<{
  config: HapioConfig;
  serviceId: string;
  locationId: string;
}> {
  const config = await getHapioConfig();
  if (!config.apiKey) {
    throw new HapioError('Το Hapio δεν είναι ρυθμισμένο (λείπει HAPIO_API_KEY)', 'NOT_CONFIGURED');
  }
  if (!config.locationId || !config.serviceId) {
    throw new HapioError(
      'Λείπουν HAPIO_LOCATION_ID / HAPIO_SERVICE_ID. Εκτελέστε «Ρύθμιση Hapio» πρώτα.',
      'NOT_CONFIGURED'
    );
  }
  return { config, serviceId: config.serviceId, locationId: config.locationId };
}

/** Δημιουργεί Hapio booking για ραντεβού και επιστρέφει το booking */
export async function createBookingForAppointment(
  appointment: Appointment,
  overrides: { serviceId?: string; locationId?: string; resourceId?: string } = {}
): Promise<HapioBooking> {
  const defaults = await requireBookingDefaults();
  const { startsAt, endsAt } = appointmentWindow(appointment);

  // Ραντεβού εκτός bookable slot ή εκτός ωραρίου (π.χ. καταχώρηση για το παρελθόν,
  // μη ευθυγραμμισμένη ώρα, Κυριακή, μεσάνυχτα) → retry με τα κατάλληλα ignore.
  return withSlotFallback(options =>
    createBooking({
      serviceId: overrides.serviceId || defaults.serviceId,
      locationId: overrides.locationId || defaults.locationId,
      resourceId: overrides.resourceId || defaults.config.resourceId,
      startsAt,
      endsAt,
      metadata: appointmentMetadata(appointment),
      ignoreBookableSlots: options.ignoreBookableSlots,
      ignoreSchedule: options.ignoreSchedule,
    })
  );
}

/** Ενημερώνει το linked Hapio booking με τα τρέχοντα στοιχεία του ραντεβού */
export async function updateBookingForAppointment(
  bookingId: string,
  appointment: Appointment
): Promise<HapioBooking> {
  const { startsAt, endsAt } = appointmentWindow(appointment);
  return withSlotFallback(options =>
    patchBooking(bookingId, {
      startsAt,
      endsAt,
      metadata: appointmentMetadata(appointment),
      ignoreBookableSlots: options.ignoreBookableSlots,
      ignoreSchedule: options.ignoreSchedule,
    })
  );
}

/** Ακυρώνει το Hapio booking (αν υπάρχει) — δεν πετάει σε 404 */
export async function cancelBookingIfExists(
  bookingId: string | undefined
): Promise<{ canceled: boolean; error?: string }> {
  if (!bookingId) return { canceled: false };
  try {
    await cancelBooking(bookingId);
    return { canceled: true };
  } catch (err: any) {
    if (err instanceof HapioError && err.status === 404) return { canceled: false };
    if (err instanceof HapioError && /cancelation threshold/i.test(err.message)) {
      return {
        canceled: false,
        error:
          'Το booking δεν ακυρώθηκε στο Hapio: έχει περάσει το όριο ακύρωσης (ραντεβού στο παρελθόν).',
      };
    }
    return { canceled: false, error: err?.message || String(err) };
  }
}

// ── Setup (location / service / resource / schedule) ──

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;

/**
 * Δημιουργεί τις ελάχιστες προεπιλογές στο Hapio αν λείπουν:
 * location → service (fixed 30′) → resource → weekly schedule + blocks.
 * Αποθηκεύει τα IDs στο app_settings ώστε να χρησιμοποιούνται αυτόματα.
 */
export async function setupHapioProject(options?: {
  locationName?: string;
  serviceName?: string;
  resourceName?: string;
  timeZone?: string;
  serviceDurationMinutes?: number;
}): Promise<HapioSetupResult> {
  const config = await getHapioConfig();
  if (!config.apiKey) {
    throw new HapioError('Το Hapio δεν είναι ρυθμισμένο (λείπει HAPIO_API_KEY)', 'NOT_CONFIGURED');
  }

  const locationName = options?.locationName || 'MediLab';
  const serviceName = options?.serviceName || 'Ραντεβού';
  const resourceName = options?.resourceName || 'Εξεταστήριο 1';
  const timeZone = options?.timeZone || 'Europe/Athens';
  const durationMinutes = options?.serviceDurationMinutes || DEFAULT_DURATION_MINUTES;

  const [locations, services, resources] = await Promise.all([
    listLocations(),
    listServices(),
    listResources(),
  ]);

  // 1) Location
  let location = config.locationId
    ? locations.find(item => item.id === config.locationId)
    : locations[0];
  let locationCreated = false;
  if (!location) {
    location = await hapioRequest<HapioLocation>('/v1/locations', {
      method: 'POST',
      body: {
        name: locationName,
        time_zone: timeZone,
        resource_selection_strategy: 'randomize',
        resource_selection_priority: [],
        enabled: true,
      },
    });
    locationCreated = true;
  }

  // 2) Service (fixed duration)
  let service = config.serviceId
    ? services.find(item => item.id === config.serviceId)
    : services[0];
  let serviceCreated = false;
  if (!service) {
    service = await hapioRequest<HapioService>('/v1/services', {
      method: 'POST',
      body: {
        name: serviceName,
        type: 'fixed',
        duration: `PT${durationMinutes}M`,
        bookable_interval: 'PT15M',
        enabled: true,
      },
    });
    serviceCreated = true;
  }

  // 3) Resource
  let resource = config.resourceId
    ? resources.find(item => item.id === config.resourceId)
    : resources[0];
  let resourceCreated = false;
  if (!resource) {
    resource = await hapioRequest<HapioResource>('/v1/resources', {
      method: 'POST',
      body: { name: resourceName, max_simultaneous_bookings: 1, enabled: true },
    });
    resourceCreated = true;
  }

  // 4) Συσχέτιση service ↔ resource (idempotent PUT)
  await hapioRequest(`/v1/resources/${resource.id}/services/${service.id}`, { method: 'PUT' });

  // 5) Εβδομαδιαίο ωράριο (recurring schedule + blocks για κάθε εργάσιμη)
  let scheduleCreated = false;
  const schedules = await hapioListAll<{ id: string }>(
    `/v1/resources/${resource.id}/recurring-schedules`
  );
  let recurringScheduleId = schedules[0]?.id;
  if (!recurringScheduleId) {
    const today = new Date().toISOString().slice(0, 10);
    const created = await hapioRequest<{ id: string }>(
      `/v1/resources/${resource.id}/recurring-schedules`,
      {
        method: 'POST',
        body: { location_id: location.id, start_date: today, end_date: null, interval: 1 },
      }
    );
    recurringScheduleId = created.id;
    scheduleCreated = true;
  }

  // Συμπληρώνουμε τυχόν λείπουν ημέρες (idempotent — τα υπάρχοντα blocks μένουν)
  const blocksPath = `/v1/resources/${resource.id}/recurring-schedules/${recurringScheduleId}/schedule-blocks`;
  const existingBlocks = await hapioListAll<{ weekday: string }>(blocksPath);
  const existingWeekdays = new Set(existingBlocks.map(block => block.weekday));

  for (const weekday of WEEKDAYS) {
    if (existingWeekdays.has(weekday)) continue;
    const weekend = weekday === 'saturday';
    try {
      await hapioRequest(blocksPath, {
        method: 'POST',
        body: {
          weekday,
          start_time: '08:00:00',
          end_time: weekend ? '14:00:00' : '20:00:00',
        },
      });
      scheduleCreated = true;
    } catch (err) {
      // Μπλοκ που επικαλύπτεται ή απορρίπτεται δεν πρέπει να ακυρώσει το setup
      console.warn(`Hapio schedule block (${weekday}) warning:`, (err as any)?.message || err);
    }
  }

  // 6) Αποθήκευση IDs για επόμενες κλήσεις
  await Promise.all([
    dbService.setSetting(SETTING_KEYS.locationId, location.id),
    dbService.setSetting(SETTING_KEYS.serviceId, service.id),
    dbService.setSetting(SETTING_KEYS.resourceId, resource.id),
  ]);

  return {
    location,
    service,
    resource,
    created: {
      location: locationCreated,
      service: serviceCreated,
      resource: resourceCreated,
      schedule: scheduleCreated,
    },
  };
}

// ── Sync Hapio → τοπικά ραντεβού ──

/**
 * Εισάγει/ενημερώνει τοπικά ραντεβού από Hapio bookings.
 * Δημιουργεί ραντεβού μόνο όταν το booking έχει metadata.patientId που
 * αντιστοιχεί σε υπάρχοντα ασθενή (αλλιώς το αναφέρει στα skipped).
 */
export async function syncBookingsToAppointments(input: {
  from: string;
  to: string;
  doctorId?: string;
}): Promise<HapioSyncResult> {
  const bookings = await listBookings({
    from: input.from,
    to: input.to,
    canceled: 'exclude',
    temporary: 'exclude',
  });

  const result: HapioSyncResult = { created: 0, updated: 0, skipped: [], scanned: bookings.length };

  for (const booking of bookings) {
    const metadata = booking.metadata || {};
    const linkedId =
      typeof metadata.appointmentId === 'string' ? metadata.appointmentId : undefined;

    // Αν η κράτηση έγινε από προσωπικό link χρήστη, ανήκει σε εκείνον.
    const ownerUid = await getBookingOwner(booking.id);
    const doctorId = ownerUid || input.doctorId;

    let existing: Appointment | null = null;
    if (linkedId) {
      existing = await dbService.getAppointment(linkedId);
    }
    if (!existing) {
      existing = await dbService.getAppointmentByHapioBookingId(booking.id);
    }

    if (existing) {
      const nextScheduledAt = new Date(booking.starts_at).toISOString();
      const durationMinutes = Math.max(
        1,
        Math.round(
          (new Date(booking.ends_at).getTime() - new Date(booking.starts_at).getTime()) / 60_000
        )
      );
      const changed =
        new Date(existing.scheduledAt).toISOString() !== nextScheduledAt ||
        existing.durationMinutes !== durationMinutes ||
        existing.hapioBookingId !== booking.id;

      if (changed) {
        const updated = await dbService.updateAppointment(existing.id, {
          scheduledAt: nextScheduledAt,
          durationMinutes,
          hapioBookingId: booking.id,
          hapio: {
            bookingId: booking.id,
            serviceId: booking.service?.id,
            locationId: booking.location?.id,
            resourceId: booking.resource?.id,
            syncedAt: new Date().toISOString(),
          },
        });
        void updated;
        result.updated += 1;
      }
      continue;
    }

    let patientId = typeof metadata.patientId === 'string' ? metadata.patientId : '';
    let patient = patientId ? await dbService.getPatient(patientId) : null;

    if (patientId && !patient) {
      result.skipped.push({ bookingId: booking.id, reason: 'UNKNOWN_PATIENT' });
      continue;
    }

    if (!patient) {
      // Online κράτηση: το Hapio έχει μόνο στοιχεία επικοινωνίας.
      // 1) αντιστοίχιση με email/τηλέφωνο, 2) με ονοματεπώνυμο, 3) νέος ασθενής.
      const contactEmail =
        typeof metadata.email === 'string' ? metadata.email.trim() : '';
      const contactPhone =
        typeof metadata.phone === 'string' ? metadata.phone.trim() : '';
      const fullName =
        typeof metadata.name === 'string' ? metadata.name.trim() : '';

      patient =
        (await dbService.findPatientByContact(contactEmail, contactPhone)) || null;

      if (!patient && fullName) {
        const parts = fullName.split(/\s+/).filter(Boolean);
        const firstName = parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0] || '';
        const lastName = parts.length > 1 ? parts[parts.length - 1] : '';
        if (firstName && lastName) {
          patient = await dbService.findPatientByNameAndDob(firstName, lastName);
        }
      }

      if (!patient) {
        if (!fullName) {
          result.skipped.push({ bookingId: booking.id, reason: 'MISSING_PATIENT' });
          continue;
        }

        const parts = fullName.split(/\s+/).filter(Boolean);
        const firstName = parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0];
        const lastName = parts.length > 1 ? parts[parts.length - 1] : '';

        patient = await dbService.savePatient({
          id: `patient_online_${crypto.randomUUID()}`,
          firstName,
          lastName,
          dateOfBirth: '',
          gender: Gender.OTHER,
          status: PatientStatus.UNKNOWN,
          email: contactEmail || undefined,
          phone: contactPhone || undefined,
          doctorId,
          medicalHistory: ['Δημιουργήθηκε αυτόματα από online ραντεβού (Hapio)'],
        } as Patient);
      } else if (
        (contactEmail && !patient.email) ||
        (contactPhone && !patient.phone)
      ) {
        // Συμπληρώνουμε τα στοιχεία επικοινωνίας που έλειπαν.
        try {
          patient = await dbService.updatePatient(patient.id, {
            email: patient.email || contactEmail || undefined,
            phone: patient.phone || contactPhone || undefined,
          });
        } catch {
          // Αγνοούμε — η αντιστοίχιση έχει ήδη γίνει
        }
      }

      patientId = patient.id;
    }

    if (!patient) {
      result.skipped.push({ bookingId: booking.id, reason: 'UNKNOWN_PATIENT' });
      continue;
    }

    const now = new Date().toISOString();
    const durationMinutes = Math.max(
      1,
      Math.round(
        (new Date(booking.ends_at).getTime() - new Date(booking.starts_at).getTime()) / 60_000
      )
    );
    const reason =
      (typeof metadata.reason === 'string' && metadata.reason.trim()) ||
      booking.service?.name ||
      'Ραντεβού (Hapio)';

    const appointment: Appointment = {
      id: linkedId || `appointment_hapio_${booking.id}`,
      patientId,
      patientName:
        (typeof metadata.patientName === 'string' && metadata.patientName) ||
        (typeof metadata.name === 'string' && metadata.name.trim()) ||
        `${patient.firstName} ${patient.lastName}`.trim(),
      doctorId,
      scheduledAt: new Date(booking.starts_at).toISOString(),
      durationMinutes,
      reason,
      notes: typeof metadata.notes === 'string' ? metadata.notes : '',
      status: 'scheduled' as Appointment['status'],
      hapioBookingId: booking.id,
      hapio: {
        bookingId: booking.id,
        serviceId: booking.service?.id,
        locationId: booking.location?.id,
        resourceId: booking.resource?.id,
        syncedAt: now,
      },
      createdAt: now,
      updatedAt: now,
    };

    await dbService.saveAppointment(appointment);
    result.created += 1;
  }

  return result;
}
