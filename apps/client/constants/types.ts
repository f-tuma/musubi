import { Mode } from "react-native-big-calendar";

export type User = {
  id: string;
  name: string;
  email: string;
};

export type Calendar = {
  id: string;
  creatorID: string;
  name: string;
  color: string;
  members: User[];
  invite: string;
  events?: Event[];
};

export type Event = {
  id: string;
  creatorID: string;
  title: string;
  color: string;
  start: Date;
  end: Date;
  calendars: string[];
};

export type Invite = {
  id: string,
  calendarID: string,
  expiresAt: Date,
  maxUses: number,
};

export type Settings = {
  showKanji: boolean,
  defaultCalendarView: Mode,
  weekStartsOn: string,
};
