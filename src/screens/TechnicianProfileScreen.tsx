// @ts-nocheck
import React from 'react';
import { motion } from 'framer-motion';
import { ArrowLeft, Mail, Phone, Award, Users, TrendingUp, Calendar } from 'lucide-react';
import { useAppStore } from '../store/appStore';

export const TechnicianProfileScreen: React.FC = () => {
  const setCurrentScreen = useAppStore((s) => s.setCurrentScreen);

  // Mock technician data
  const technician = {
    id: 'tech-001',
    name: 'Maria Elena Garcia',
    email: 'maria.garcia@hvac.com',
    phone: '602-555-0101',
    specialization: 'Residential Cooling Systems',
    yearsExperience: 12,
    customersServed: 156,
    certifications: ['Universal', 'EPA 608', 'Type II'],
    rating: 4.8,
    reviewsCount: 47,
    averageJobTime: 2.5,
    totalRevenue: '$48,750',
    thisMonthRevenue: '$4,200',
  };

  const recentJobs = [
    { date: '2024-09-05', customer: 'Smith Residence', work: 'Seasonal maintenance', revenue: '$385' },
    { date: '2024-09-03', customer: 'Tech Solutions Inc.', work: 'Heat pump replacement', revenue: '$3,200' },
    { date: '2024-08-30', customer: 'Martinez LLC', work: 'AC repair', revenue: '$650' },
    { date: '2024-08-28', customer: 'Johnson Enterprises', work: 'Filter replacement', revenue: '$125' },
    { date: '2024-08-25', customer: 'Garcia Household', work: 'Maintenance visit', revenue: '$295' },
  ];

  return (
    <div className="min-h-screen bg-gradient-to-br from-accent-900 to-accent-800">
      {/* Header */}
      <header className="border-b border-accent-700 bg-accent-900 backdrop-blur sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center gap-4">
          <motion.button
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            onClick={() => setCurrentScreen('dashboard')}
            className="p-2 hover:bg-accent-800 rounded-lg transition-colors"
          >
            <ArrowLeft className="w-5 h-5 text-primary-400" />
          </motion.button>
          <div>
            <h1 className="text-2xl font-bold text-accent-50">Technician Profile</h1>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-6xl mx-auto px-4 py-8">
        {/* Profile Card */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="border border-accent-700 rounded-lg bg-accent-900/50 p-8 mb-8"
        >
          <div className="flex items-start justify-between mb-6">
            <div>
              <h2 className="text-3xl font-bold text-accent-50">{technician.name}</h2>
              <p className="text-primary-400 font-medium mt-1">{technician.specialization}</p>
            </div>
            <div className="text-right">
              <div className="flex items-center gap-1 justify-end mb-2">
                <span className="text-2xl font-bold text-accent-50">{technician.rating}</span>
                <span className="text-warning">★</span>
              </div>
              <p className="text-xs text-accent-500">{technician.reviewsCount} reviews</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
            <div className="flex items-center gap-3">
              <Mail className="w-5 h-5 text-primary-400" />
              <div>
                <p className="text-xs text-accent-500">Email</p>
                <p className="text-sm text-accent-50">{technician.email}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Phone className="w-5 h-5 text-primary-400" />
              <div>
                <p className="text-xs text-accent-500">Phone</p>
                <p className="text-sm text-accent-50">{technician.phone}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Award className="w-5 h-5 text-primary-400" />
              <div>
                <p className="text-xs text-accent-500">Experience</p>
                <p className="text-sm text-accent-50">{technician.yearsExperience} years</p>
              </div>
            </div>
          </div>

          {/* Certifications */}
          <div className="mb-6">
            <p className="text-xs font-semibold text-accent-400 uppercase tracking-wide mb-3">Certifications</p>
            <div className="flex flex-wrap gap-2">
              {technician.certifications.map((cert) => (
                <span
                  key={cert}
                  className="px-3 py-1 rounded-full text-xs font-medium bg-primary-900/50 text-primary-300 border border-primary-700"
                >
                  {cert}
                </span>
              ))}
            </div>
          </div>
        </motion.div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
          {/* Performance Stats */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
            className="border border-accent-700 rounded-lg bg-accent-900/50 p-6"
          >
            <div className="flex items-center gap-2 mb-4">
              <Users className="w-5 h-5 text-secondary-400" />
              <h3 className="font-semibold text-accent-50">Customers Served</h3>
            </div>
            <p className="text-4xl font-bold text-secondary-400">{technician.customersServed}</p>
            <p className="text-xs text-accent-500 mt-2">Active relationships</p>
          </motion.div>

          {/* This Month Revenue */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 }}
            className="border border-accent-700 rounded-lg bg-accent-900/50 p-6"
          >
            <div className="flex items-center gap-2 mb-4">
              <TrendingUp className="w-5 h-5 text-success" />
              <h3 className="font-semibold text-accent-50">This Month</h3>
            </div>
            <p className="text-4xl font-bold text-success">{technician.thisMonthRevenue}</p>
            <p className="text-xs text-accent-500 mt-2">Total revenue</p>
          </motion.div>

          {/* Career Revenue */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="border border-accent-700 rounded-lg bg-accent-900/50 p-6"
          >
            <div className="flex items-center gap-2 mb-4">
              <TrendingUp className="w-5 h-5 text-primary-400" />
              <h3 className="font-semibold text-accent-50">Career Total</h3>
            </div>
            <p className="text-4xl font-bold text-primary-400">{technician.totalRevenue}</p>
            <p className="text-xs text-accent-500 mt-2">All-time revenue</p>
          </motion.div>
        </div>

        {/* Recent Jobs */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25 }}
          className="border border-accent-700 rounded-lg bg-accent-900/50 p-6"
        >
          <div className="flex items-center gap-2 mb-4">
            <Calendar className="w-5 h-5 text-primary-400" />
            <h3 className="font-semibold text-accent-50">Recent Jobs</h3>
          </div>
          <div className="space-y-3">
            {recentJobs.map((job, index) => (
              <motion.div
                key={job.date}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.3 + index * 0.05 }}
                className="border border-accent-700 rounded p-4 hover:bg-accent-800/50 transition-colors"
              >
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <p className="font-medium text-accent-50">{job.customer}</p>
                    <p className="text-sm text-accent-400 mt-1">{job.work}</p>
                    <p className="text-xs text-accent-500 mt-2">{job.date}</p>
                  </div>
                  <p className="font-semibold text-success text-lg">{job.revenue}</p>
                </div>
              </motion.div>
            ))}
          </div>
        </motion.div>
      </main>
    </div>
  );
};
