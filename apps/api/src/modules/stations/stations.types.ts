import type { Prisma } from '../../generated/prisma/client.js';

export const pickerSelect = {
  id: true,
  name: true,
  address: true,
  latitude: true,
  longitude: true,
} satisfies Prisma.StationSelect;
export const stationSelect = {
  ...pickerSelect,
  isActive: true,
  managerId: true,
  createdAt: true,
} satisfies Prisma.StationSelect;

type PickerRecord = Prisma.StationGetPayload<{ select: typeof pickerSelect }>;
type StationRecord = Prisma.StationGetPayload<{ select: typeof stationSelect }>;

export function pickerStation(station: PickerRecord) {
  return {
    id: station.id,
    name: station.name,
    address: station.address,
    latitude: station.latitude === null ? null : Number(station.latitude),
    longitude: station.longitude === null ? null : Number(station.longitude),
  };
}
export function managedStation(station: StationRecord) {
  return {
    ...pickerStation(station),
    isActive: station.isActive,
    managerId: station.managerId,
    createdAt: station.createdAt,
  };
}
