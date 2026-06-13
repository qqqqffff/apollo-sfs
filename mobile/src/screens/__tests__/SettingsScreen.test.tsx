import React from 'react';
import { Switch } from 'react-native';
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import SettingsScreen from '../SettingsScreen';

// backgroundSync exports are used for key constants
jest.mock('../../tasks/backgroundSync', () => ({
  registerBackgroundSync: jest.fn(),
  NIGHTSYNC_KEY: 'apollo_nightsync_enabled',
  NIGHTSYNC_HOUR_KEY: 'apollo_nightsync_hour',
  NIGHTSYNC_DEFAULT_HOUR: 4,
}));

const mockedAsyncStorage = AsyncStorage as jest.Mocked<typeof AsyncStorage>;

beforeEach(() => {
  jest.clearAllMocks();
  mockedAsyncStorage.getItem.mockResolvedValue(null);
});

// ── Rendering ─────────────────────────────────────────────────────────────────

describe('initial render', () => {
  it('renders the Wi-Fi only row', () => {
    const { getByText } = render(<SettingsScreen />);
    expect(getByText('Wi-Fi only')).toBeTruthy();
  });

  it('renders the Night backup row', () => {
    const { getByText } = render(<SettingsScreen />);
    expect(getByText('Night backup')).toBeTruthy();
  });

  it('hides sync time row when night backup is off', () => {
    const { queryByText } = render(<SettingsScreen />);
    expect(queryByText('Sync time')).toBeNull();
  });

  it('loads stored values from AsyncStorage on mount', async () => {
    mockedAsyncStorage.getItem
      .mockResolvedValueOnce('true')   // WIFI_ONLY_KEY
      .mockResolvedValueOnce('true')   // NIGHTSYNC_KEY
      .mockResolvedValueOnce('22');    // NIGHTSYNC_HOUR_KEY

    const { findByText } = render(<SettingsScreen />);
    // Night backup enabled → sync time row should appear
    await findByText('Sync time');
  });
});

// ── Wi-Fi only toggle ─────────────────────────────────────────────────────────

describe('Wi-Fi only toggle', () => {
  it('starts unchecked when AsyncStorage has no value', async () => {
    const { UNSAFE_getAllByType } = render(<SettingsScreen />);
    await waitFor(() => {
      const switches = UNSAFE_getAllByType(Switch);
      expect(switches[0].props.value).toBe(false);
    });
  });

  it('starts checked when AsyncStorage returns "true"', async () => {
    mockedAsyncStorage.getItem.mockResolvedValueOnce('true'); // WIFI_ONLY
    const { UNSAFE_getAllByType } = render(<SettingsScreen />);
    await waitFor(() => {
      const switches = UNSAFE_getAllByType(Switch);
      expect(switches[0].props.value).toBe(true);
    });
  });

  it('calls AsyncStorage.setItem with "true" when toggled on', async () => {
    const { UNSAFE_getAllByType } = render(<SettingsScreen />);
    await waitFor(() => UNSAFE_getAllByType(Switch));
    const wifiSwitch = UNSAFE_getAllByType(Switch)[0];
    fireEvent(wifiSwitch, 'onValueChange', true);
    expect(mockedAsyncStorage.setItem).toHaveBeenCalledWith('apollo_wifi_only', 'true');
  });

  it('calls AsyncStorage.setItem with "false" when toggled off', async () => {
    mockedAsyncStorage.getItem.mockResolvedValueOnce('true');
    const { UNSAFE_getAllByType } = render(<SettingsScreen />);
    await waitFor(() => {
      expect(UNSAFE_getAllByType(Switch)[0].props.value).toBe(true);
    });
    fireEvent(UNSAFE_getAllByType(Switch)[0], 'onValueChange', false);
    expect(mockedAsyncStorage.setItem).toHaveBeenCalledWith('apollo_wifi_only', 'false');
  });
});

// ── Night backup toggle ───────────────────────────────────────────────────────

describe('night backup toggle', () => {
  it('shows sync time row when night backup is enabled', async () => {
    const { UNSAFE_getAllByType, findByText } = render(<SettingsScreen />);
    await waitFor(() => UNSAFE_getAllByType(Switch));
    const nightSwitch = UNSAFE_getAllByType(Switch)[1];
    fireEvent(nightSwitch, 'onValueChange', true);
    await findByText('Sync time');
  });

  it('hides sync time row when night backup is disabled again', async () => {
    const { UNSAFE_getAllByType, findByText, queryByText } = render(<SettingsScreen />);
    await waitFor(() => UNSAFE_getAllByType(Switch));
    const nightSwitch = UNSAFE_getAllByType(Switch)[1];

    fireEvent(nightSwitch, 'onValueChange', true);
    await findByText('Sync time');

    fireEvent(nightSwitch, 'onValueChange', false);
    await waitFor(() => expect(queryByText('Sync time')).toBeNull());
  });

  it('saves night backup state to AsyncStorage', async () => {
    const { UNSAFE_getAllByType } = render(<SettingsScreen />);
    await waitFor(() => UNSAFE_getAllByType(Switch));
    fireEvent(UNSAFE_getAllByType(Switch)[1], 'onValueChange', true);
    expect(mockedAsyncStorage.setItem).toHaveBeenCalledWith('apollo_nightsync_enabled', 'true');
  });
});

// ── Hour picker ───────────────────────────────────────────────────────────────

describe('sync time hour picker', () => {
  async function openPicker() {
    const screen = render(<SettingsScreen />);
    await waitFor(() => screen.UNSAFE_getAllByType(Switch));
    // Enable night backup to reveal sync time row
    fireEvent(screen.UNSAFE_getAllByType(Switch)[1], 'onValueChange', true);
    await screen.findByText('Sync time');
    fireEvent.press(screen.getByText('Sync time'));
    return screen;
  }

  it('opens the hour picker modal on tapping Sync time', async () => {
    const { findByText } = await openPicker();
    // Hour picker shows AM/PM times; 12:00 AM is always present
    await findByText('12:00 AM');
  });

  it('shows all 24 hours in the picker', async () => {
    const { findByText } = await openPicker();
    await findByText('12:00 AM');
    await findByText('12:00 PM');
  });

  it('saves selected hour to AsyncStorage', async () => {
    const { findByText } = await openPicker();
    await findByText('11:00 PM');
    fireEvent.press(await findByText('11:00 PM'));
    expect(mockedAsyncStorage.setItem).toHaveBeenCalledWith('apollo_nightsync_hour', '23');
  });

  it('closes picker after selecting an hour', async () => {
    const { findByText, queryByText } = await openPicker();
    await findByText('1:00 AM');
    fireEvent.press(await findByText('1:00 AM'));
    await waitFor(() => expect(queryByText('12:00 AM')).toBeNull());
  });
});
