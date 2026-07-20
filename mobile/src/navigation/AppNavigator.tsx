import React, { useEffect } from 'react';
import { Image, Linking, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { NavigationContainer, LinkingOptions } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Activity, Folder, Home, Settings, User } from 'lucide-react-native';
import { useAuth } from '../context/AuthContext';
import { colors } from '../theme';
import LoginScreen from '../screens/LoginScreen';
import RegisterScreen from '../screens/RegisterScreen';
import AccountRequestScreen from '../screens/AccountRequestScreen';
import HomeScreen from '../screens/HomeScreen';
import FilesScreen from '../screens/FilesScreen';
import ProfileScreen from '../screens/ProfileScreen';
import SettingsScreen from '../screens/SettingsScreen';
import MetricsScreen from '../screens/MetricsScreen';
import NotificationsScreen from '../screens/NotificationsScreen';
import OrdersScreen from '../screens/OrdersScreen';
import ChangePasswordScreen from '../screens/ChangePasswordScreen';
import SharedScreen from '../screens/SharedScreen';

const Stack = createStackNavigator();
const Tab = createBottomTabNavigator();

const TAB_ICONS: Record<string, React.ComponentType<{ size: number; color: string; strokeWidth?: number }>> = {
  Home: Home,
  Files: Folder,
  Metrics: Activity,
  Profile: User,
  Settings: Settings,
};

function AuthStack({ initialToken }: { initialToken?: string }) {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Login" component={LoginScreen} />
      <Stack.Screen
        name="Register"
        component={RegisterScreen}
        initialParams={{ token: initialToken }}
      />
      <Stack.Screen name="AccountRequest" component={AccountRequestScreen} />
    </Stack.Navigator>
  );
}

function MainTabs() {
  const { profile } = useAuth();
  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.surface }}>
    <Tab.Navigator
      screenOptions={({ route }) => ({
        tabBarIcon: ({ focused, color, size }) => {
          const Icon = TAB_ICONS[route.name];
          if (!Icon) return null;
          return <Icon size={size} color={color} strokeWidth={focused ? 2.5 : 1.5} />;
        },
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
        },
        headerShown: false,
      })}
    >
      <Tab.Screen name="Home" component={HomeScreen} options={{ title: 'Home' }} />
      <Tab.Screen name="Files" component={FilesScreen} options={{ title: 'Files' }} />
      {/* Admin-only: the system metrics dashboard (the one admin page kept on
          mobile), including the server alarm notification configuration. */}
      {profile?.is_admin && (
        <Tab.Screen name="Metrics" component={MetricsScreen} options={{ title: 'Metrics' }} />
      )}
      <Tab.Screen name="Profile" component={ProfileScreen} options={{ title: 'Profile' }} />
      <Tab.Screen name="Settings" component={SettingsScreen} options={{ title: 'Settings' }} />
    </Tab.Navigator>
    </SafeAreaView>
  );
}

export default function AppNavigator() {
  const { isAuthenticated, isLoading } = useAuth();
  const [initialToken, setInitialToken] = React.useState<string | undefined>();

  const linking = React.useMemo<LinkingOptions<ReactNavigation.RootParamList>>(() => ({
    prefixes: ['apollosfs://', 'https://apollo-sfs.com'],
    config: {
      screens: isAuthenticated
        ? {
            Main: {
              screens: {
                Home: 'home',
                Files: 'files',
                Metrics: 'admin/metrics',
                Profile: 'profile',
                Settings: 'settings',
              },
            },
            Notifications: 'notifications',
            Orders: 'client/orders',
            Shared: 'client/shared',
            ChangePassword: 'client/change-password',
          }
        : {
            Auth: {
              screens: {
                Login: '',
                Register: 'register',
                AccountRequest: 'interest',
              },
            },
          },
    },
  }), [isAuthenticated]);

  useEffect(() => {
    Linking.getInitialURL().then((url) => {
      if (url) {
        try {
          const parsed = new URL(url);
          const token = parsed.searchParams.get('token');
          if (token) setInitialToken(token);
        } catch {
          // malformed URL
        }
      }
    });
  }, []);

  if (isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' }}>
        <Image source={require('../assets/app-icon.png')} style={{ width: 96, height: 96, borderRadius: 22 }} />
      </View>
    );
  }

  return (
    <NavigationContainer linking={linking}>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {isAuthenticated ? (
          <>
            <Stack.Screen name="Main" component={MainTabs} />
            {/* Pushed over the tabs — reached from the Profile page. */}
            <Stack.Screen name="Notifications" component={NotificationsScreen} />
            <Stack.Screen name="Orders" component={OrdersScreen} />
            <Stack.Screen name="ChangePassword" component={ChangePasswordScreen} />
            <Stack.Screen name="Shared" component={SharedScreen} />
          </>
        ) : (
          <Stack.Screen name="Auth">
            {() => <AuthStack initialToken={initialToken} />}
          </Stack.Screen>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
