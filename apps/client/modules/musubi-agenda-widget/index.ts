import { NativeModule, requireOptionalNativeModule } from "expo";

declare class MusubiAgendaWidgetModule extends NativeModule {
  beginSession(scope: string): Promise<number>;
  updateSnapshot(snapshot: string): Promise<boolean>;
  clearSnapshot(): Promise<void>;
  getCalendarWidgetSelection(widgetId: number): Promise<string[] | null>;
  setCalendarWidgetSelection(widgetId: number, calendarIds: string[]): Promise<void>;
  getTasksWidgetSelection(widgetId: number): Promise<string[] | null>;
  setTasksWidgetSelection(widgetId: number, calendarIds: string[]): Promise<void>;
}

export default requireOptionalNativeModule<MusubiAgendaWidgetModule>("MusubiAgendaWidget");
