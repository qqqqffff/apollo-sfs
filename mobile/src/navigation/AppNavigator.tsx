import React, { useEffect } from 'react';
import { NavigationContainer, LinkingOptions } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import * as Linking from 'expo-linking';
import { Text } from 'react-native';
import { useAuth } from '../context/AuthContext';
import LoginScreen from '../screens/LoginScreen';
import RegisterScreen from '../screens/RegisterScreen';
import HomeScreen from '../screens/HomeScreen';
import FilesScreen from '../screens/FilesScreen';
import FavoritesScreen from '../screens/FavoritesScreen';
import ProfileScreen from '../screens/ProfileScreen';
import SettingsScreen from '../screens/SettingsScreen';

const Stack = createStackNavigator();
const Tab = createBottomTabNavigator();

function AuthStack({ initialToken }: { initialToken?: string }) {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Login" component={LoginScreen} />
      <Stack.Screen
        name="Register"
        component={RegisterScreen}
        initialParams={{ token: initialToken }}
      />
    </Stack.Navigator>
  );
}

function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        tabBarIcon: () => {
          const icons: Record<string, string> = {
            Home: '🏠',
            Files: '📁',
            Favorites: '★',
            Profile: '👤',
            Settings: '⚙️',
          };
          return <Text>{icons[route.name] ?? '?'}</Text>;
        },
      })}
    >
      <Tab.Screen name="Home" component={HomeScreen} />
      <Tab.Screen name="Files" component={FilesScreen} />
      <Tab.Screen name="Favorites" component={FavoritesScreen} />
      <Tab.Screen name="Profile" component={ProfileScreen} />
      <Tab.Screen name="Settings" component={SettingsScreen} />
    </Tab.Navigator>
  );
}

const linking: LinkingOptions<ReactNavigation.RootParamList> = {
  prefixes: [Linking.createURL('/'), 'https://apollo-sfs.com'],
  config: {
    screens: {
      Auth: {
        screens: {
          Register: 'register',
        },
      },
    },
  },
};

export default function AppNavigator() {
  const { isAuthenticated, isLoading } = useAuth();
  const [initialToken, setInitialToken] = React.useState<string | undefined>();

  useEffect(() => {
    Linking.getInitialURL().then((url) => {
      if (url) {
        const parsed = Linking.parse(url);
        if (parsed.queryParams?.token) {
          setInitialToken(String(parsed.queryParams.token));
        }
      }
    });
  }, []);

  if (isLoading) return null;

  return (
    <NavigationContainer linking={linking}>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        {isAuthenticated ? (
          <Stack.Screen name="Main" component={MainTabs} />
        ) : (
          <Stack.Screen name="Auth">
            {() => <AuthStack initialToken={initialToken} />}
          </Stack.Screen>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
